// Command mock-bb is a fake bb that implements the bb HTTP contract
// (docs/bb-contract.md) with a Durable-Object-like, per-task, append-only event
// log held in memory, plus failure switches for tests and failure drills.
//
// Failure switches can be set three ways (later wins):
//
//  1. environment variables at startup (MOCK_BB_*; see config below)
//  2. POST /admin/config with a JSON body (same field names) at runtime
//  3. per-request headers X-Mock-<Field> (e.g. X-Mock-Fail-First: 2)
//
// GET /admin/state exposes the ground truth the drills assert against: how many
// runs each task started, which ids are aliases, and every run's status.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const protocolVersion = 1

// config holds every failure switch. Durations are Go duration strings in JSON
// and env vars ("1500ms", "2m").
type config struct {
	FailFirst       int      `json:"failFirst"`      // fail the first N non-admin requests with 503
	FailFor         duration `json:"failFor"`        // 503 every non-admin request for this long (from when it was set)
	AcceptThenDrop  int      `json:"acceptThenDrop"` // persist the next N PUTs, then drop the connection instead of answering
	DropAfter       int      `json:"dropAfter"`      // close each events stream after N events
	SilentFor       duration `json:"silentFor"`      // new runs go silent (no events, no heartbeats) for this long after their first event
	StepDelay       duration `json:"stepDelay"`      // delay between work events ("slow run" = make this big)
	ResultAfter     int      `json:"resultAfter"`    // emit the result after K work events
	HeartbeatEvery  duration `json:"heartbeatEvery"` // heartbeat cadence while a run is working
	ResultStatus    string   `json:"resultStatus"`   // succeeded | failed
	DuplicatePut    bool     `json:"duplicatePut"`   // process each PUT twice concurrently (idempotency self-check)
	RequireToken    string   `json:"-"`              // bearer token; empty disables auth
	failForDeadline time.Time
}

type duration struct{ time.Duration }

func (d *duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		v, err := time.ParseDuration(s)
		d.Duration = v
		return err
	}
	var n int64
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	d.Duration = time.Duration(n) * time.Millisecond
	return nil
}

func (d duration) MarshalJSON() ([]byte, error) { return json.Marshal(d.String()) }

func defaultConfig() config {
	return config{
		StepDelay:      duration{300 * time.Millisecond},
		ResultAfter:    6,
		HeartbeatEvery: duration{2 * time.Second},
		ResultStatus:   "succeeded",
	}
}

func envConfig() config {
	c := defaultConfig()
	i := func(k string, dst *int) {
		if v, err := strconv.Atoi(os.Getenv(k)); err == nil {
			*dst = v
		}
	}
	d := func(k string, dst *duration) {
		if v, err := time.ParseDuration(os.Getenv(k)); err == nil {
			dst.Duration = v
		}
	}
	i("MOCK_BB_FAIL_FIRST", &c.FailFirst)
	d("MOCK_BB_FAIL_FOR", &c.FailFor)
	i("MOCK_BB_ACCEPT_THEN_DROP", &c.AcceptThenDrop)
	i("MOCK_BB_DROP_AFTER", &c.DropAfter)
	d("MOCK_BB_SILENT_FOR", &c.SilentFor)
	d("MOCK_BB_STEP_DELAY", &c.StepDelay)
	i("MOCK_BB_RESULT_AFTER", &c.ResultAfter)
	d("MOCK_BB_HEARTBEAT_EVERY", &c.HeartbeatEvery)
	if v := os.Getenv("MOCK_BB_RESULT_STATUS"); v != "" {
		c.ResultStatus = v
	}
	c.DuplicatePut = os.Getenv("MOCK_BB_DUPLICATE_PUT") == "1"
	c.RequireToken = os.Getenv("MOCK_BB_TOKEN")
	if c.FailFor.Duration > 0 {
		c.failForDeadline = time.Now().Add(c.FailFor.Duration)
	}
	return c
}

// --- task store (the "Durable Object") --------------------------------------

type event struct {
	ID        int64          `json:"id"`
	Kind      string         `json:"kind"`
	At        time.Time      `json:"at"`
	Text      string         `json:"text,omitempty"`
	CallID    string         `json:"callId,omitempty"`
	Tool      string         `json:"tool,omitempty"`
	Input     map[string]any `json:"input,omitempty"`
	Output    string         `json:"output,omitempty"`
	Phase     string         `json:"phase,omitempty"`
	Status    string         `json:"status,omitempty"`
	Summary   string         `json:"summary,omitempty"`
	PRURL     string         `json:"prUrl,omitempty"`
	SessionID string         `json:"sessionId,omitempty"`
	Error     string         `json:"error,omitempty"`
	Message   string         `json:"message,omitempty"`
}

type putRequest struct {
	ProtocolVersion int    `json:"protocolVersion"`
	TaskID          string `json:"taskId"`
	MulticaTaskID   string `json:"multicaTaskId"`
	RetryOf         string `json:"retryOf"`
	Attempt         int    `json:"attempt"`
	Prompt          string `json:"prompt"`
	ResumeSessionID string `json:"resumeSessionId"`
	Issue           *struct {
		ID         string `json:"id"`
		Identifier string `json:"identifier"`
	} `json:"issue"`
}

type task struct {
	ID          string    `json:"id"`
	SessionID   string    `json:"sessionId"`
	Status      string    `json:"status"` // running | succeeded | failed | cancelled
	Aliases     []string  `json:"aliases"`
	Issue       string    `json:"issue,omitempty"`
	ResumedFrom string    `json:"resumedFrom,omitempty"`
	PutCount    int       `json:"putCount"`
	CreatedAt   time.Time `json:"createdAt"`
	EventCount  int       `json:"eventCount"`

	events  []event
	changed chan struct{}
	cancel  context.CancelFunc
}

type server struct {
	mu        sync.Mutex
	cfg       config
	tasks     map[string]*task // canonical id -> task
	alias     map[string]string
	tombstone map[string]bool
	sessions  map[string]int // session id -> runs started in it
	runs      int
	requests  int
	log       *slog.Logger
	baseCtx   context.Context
}

func newServer(ctx context.Context, cfg config, log *slog.Logger) *server {
	return &server{cfg: cfg, tasks: map[string]*task{}, alias: map[string]string{}, tombstone: map[string]bool{}, sessions: map[string]int{}, log: log, baseCtx: ctx}
}

func (s *server) resolveLocked(id string) string {
	if c, ok := s.alias[id]; ok {
		return c
	}
	return id
}

func (s *server) appendLocked(t *task, ev event) {
	if t.Status != "running" {
		return // the log is closed once a result is written
	}
	ev.ID = int64(len(t.events) + 1)
	ev.At = time.Now().UTC()
	t.events = append(t.events, ev)
	t.EventCount = len(t.events)
	if ev.Kind == "result" {
		t.Status = ev.Status
		if t.cancel != nil {
			t.cancel()
		}
	}
	close(t.changed)
	t.changed = make(chan struct{})
}

func (s *server) append(t *task, ev event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.appendLocked(t, ev)
}

// effective merges per-request header overrides onto the live config.
func (s *server) effective(r *http.Request) config {
	s.mu.Lock()
	c := s.cfg
	s.mu.Unlock()
	h := func(name string) string { return r.Header.Get("X-Mock-" + name) }
	if v, err := strconv.Atoi(h("Fail-First")); err == nil {
		c.FailFirst = v
	}
	if v, err := strconv.Atoi(h("Drop-After")); err == nil {
		c.DropAfter = v
	}
	if v, err := time.ParseDuration(h("Silent-For")); err == nil {
		c.SilentFor.Duration = v
	}
	if v, err := time.ParseDuration(h("Step-Delay")); err == nil {
		c.StepDelay.Duration = v
	}
	if v, err := strconv.Atoi(h("Result-After")); err == nil {
		c.ResultAfter = v
	}
	if v := h("Result-Status"); v != "" {
		c.ResultStatus = v
	}
	if h("Duplicate-Put") == "1" {
		c.DuplicatePut = true
	}
	return c
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// gate applies auth and the 503 switches to contract endpoints.
func (s *server) gate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c := s.effective(r)
		if c.RequireToken != "" && r.Header.Get("Authorization") != "Bearer "+c.RequireToken {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "bad token"})
			return
		}
		s.mu.Lock()
		s.requests++
		n := s.requests
		failFor := !s.cfg.failForDeadline.IsZero() && time.Now().Before(s.cfg.failForDeadline)
		s.mu.Unlock()
		if n <= c.FailFirst || failFor {
			s.log.Info("injected 503", "path", r.URL.Path, "request", n)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "mock: injected failure"})
			return
		}
		next(w, r)
	}
}

func (s *server) handlePut(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var req putRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if req.ProtocolVersion != protocolVersion {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("unsupported protocolVersion %d", req.ProtocolVersion)})
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "prompt required"})
		return
	}
	c := s.effective(r)

	var (
		resp map[string]any
		code int
	)
	if c.DuplicatePut {
		// Two concurrent creates for the same id must still yield one run.
		var wg sync.WaitGroup
		resps, codes := make([]map[string]any, 2), make([]int, 2)
		for i := range 2 {
			wg.Add(1)
			go func() { defer wg.Done(); resps[i], codes[i] = s.create(id, req, c) }()
		}
		wg.Wait()
		resp, code = resps[0], codes[0]
	} else {
		resp, code = s.create(id, req, c)
	}

	s.mu.Lock()
	drop := s.cfg.AcceptThenDrop > 0 && code == http.StatusOK
	if drop {
		s.cfg.AcceptThenDrop--
	}
	s.mu.Unlock()
	if drop {
		// The task is durably stored; the caller just never hears about it.
		s.log.Info("accepted then dropped connection", "task", id)
		if hj, ok := w.(http.Hijacker); ok {
			if conn, _, err := hj.Hijack(); err == nil {
				_ = conn.Close()
				return
			}
		}
		panic(http.ErrAbortHandler)
	}
	writeJSON(w, code, resp)
}

func (s *server) create(id string, req putRequest, c config) (map[string]any, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tombstone[id] {
		return map[string]any{"error": "task was cancelled before it was created"}, http.StatusConflict
	}
	canon := s.resolveLocked(id)
	if _, ok := s.tasks[canon]; !ok && req.RetryOf != "" {
		if parent, ok := s.tasks[s.resolveLocked(req.RetryOf)]; ok {
			s.alias[id] = parent.ID
			parent.Aliases = append(parent.Aliases, id)
			canon = parent.ID
			s.log.Info("retry aliased to existing run", "task", id, "run", parent.ID, "retryOf", req.RetryOf)
		}
	}
	if t, ok := s.tasks[canon]; ok {
		t.PutCount++
		return map[string]any{"taskId": t.ID, "created": false, "status": t.Status, "sessionId": t.SessionID, "lastEventId": len(t.events), "protocolVersion": protocolVersion}, http.StatusOK
	}
	session := req.ResumeSessionID
	if session == "" {
		session = "bbsess-" + shortID(id)
	}
	ctx, cancel := context.WithCancel(s.baseCtx)
	t := &task{ID: id, SessionID: session, Status: "running", Aliases: []string{}, PutCount: 1, CreatedAt: time.Now().UTC(), changed: make(chan struct{}), cancel: cancel, ResumedFrom: req.ResumeSessionID}
	if req.Issue != nil {
		t.Issue = req.Issue.Identifier
	}
	s.tasks[id] = t
	s.runs++
	s.sessions[session]++
	s.log.Info("run started", "task", id, "session", session, "resumed", req.ResumeSessionID != "", "issue", t.Issue)
	go s.work(ctx, t, req, c)
	return map[string]any{"taskId": id, "created": true, "status": "running", "sessionId": session, "lastEventId": 0, "protocolVersion": protocolVersion}, http.StatusOK
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// work is the fake agent: thought, tool calls, text, heartbeats, result.
func (s *server) work(ctx context.Context, t *task, req putRequest, c config) {
	sleep := func(d time.Duration) bool {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(d):
			return true
		}
	}
	// Heartbeats run alongside the work, paused while the run is "silent".
	var silentUntil time.Time
	var silentMu sync.Mutex
	go func() {
		if c.HeartbeatEvery.Duration <= 0 {
			return
		}
		tk := time.NewTicker(c.HeartbeatEvery.Duration)
		defer tk.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tk.C:
				silentMu.Lock()
				quiet := time.Now().Before(silentUntil)
				silentMu.Unlock()
				if !quiet {
					s.append(t, event{Kind: "heartbeat"})
				}
			}
		}
	}()

	verb := "Starting"
	if req.ResumeSessionID != "" {
		verb = "Resuming session " + req.ResumeSessionID + ";"
	}
	s.append(t, event{Kind: "thought", Text: verb + " reading the issue and planning."})
	if c.SilentFor.Duration > 0 {
		silentMu.Lock()
		silentUntil = time.Now().Add(c.SilentFor.Duration)
		silentMu.Unlock()
		s.log.Info("run going silent", "task", t.ID, "for", c.SilentFor.Duration)
		if !sleep(c.SilentFor.Duration) {
			return
		}
	}
	for i := 1; i <= c.ResultAfter; i++ {
		if !sleep(c.StepDelay.Duration) {
			return
		}
		switch i % 3 {
		case 1:
			call := fmt.Sprintf("call-%d", i)
			s.append(t, event{Kind: "tool_call", Phase: "start", CallID: call, Tool: "bash", Input: map[string]any{"command": fmt.Sprintf("step %d", i)}})
			if !sleep(c.StepDelay.Duration / 2) {
				return
			}
			s.append(t, event{Kind: "tool_call", Phase: "end", CallID: call, Tool: "bash", Output: "ok"})
		case 2:
			s.append(t, event{Kind: "thought", Text: fmt.Sprintf("Considering step %d.", i)})
		default:
			s.append(t, event{Kind: "text", Text: fmt.Sprintf("Finished step %d. ", i)})
		}
	}
	status := c.ResultStatus
	if strings.Contains(req.Prompt, "[mock:fail]") {
		status = "failed"
	}
	res := event{Kind: "result", Status: status, SessionID: t.SessionID}
	if status == "succeeded" {
		res.Summary = fmt.Sprintf("mock-bb completed the task in %d steps.", c.ResultAfter)
		res.PRURL = "https://github.com/example/repo/pull/" + strconv.Itoa(1000+len(t.ID)%97)
	} else {
		res.Error = "mock-bb: simulated failure"
	}
	s.append(t, res)
	s.log.Info("run finished", "task", t.ID, "status", status)
}

func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	if since == 0 {
		since, _ = strconv.ParseInt(r.Header.Get("Last-Event-ID"), 10, 64)
	}
	c := s.effective(r)
	s.mu.Lock()
	t, ok := s.tasks[s.resolveLocked(r.PathValue("id"))]
	s.mu.Unlock()
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown task"})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	sent := 0
	for {
		s.mu.Lock()
		var pending []event
		if int(since) < len(t.events) {
			pending = append(pending, t.events[since:]...)
		}
		done := t.Status != "running"
		changed := t.changed
		s.mu.Unlock()
		for _, ev := range pending {
			raw, _ := json.Marshal(ev)
			if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", ev.ID, ev.Kind, raw); err != nil {
				return
			}
			flusher.Flush()
			since = ev.ID
			sent++
			if c.DropAfter > 0 && sent >= c.DropAfter && ev.Kind != "result" {
				s.log.Info("dropping events stream", "task", t.ID, "after", sent, "last", since)
				return
			}
		}
		if done && int(since) >= len(t.events) {
			return
		}
		select {
		case <-changed:
		case <-r.Context().Done():
			return
		}
	}
}

func (s *server) handleCancel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tasks[s.resolveLocked(id)]
	if !ok {
		s.tombstone[id] = true
		writeJSON(w, http.StatusOK, map[string]any{"taskId": id, "status": "cancelled", "tombstoned": true})
		return
	}
	s.appendLocked(t, event{Kind: "result", Status: "cancelled", SessionID: t.SessionID})
	s.log.Info("run cancelled", "task", t.ID, "via", id)
	writeJSON(w, http.StatusOK, map[string]any{"taskId": t.ID, "status": t.Status})
}

func (s *server) handleTask(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tasks[s.resolveLocked(r.PathValue("id"))]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown task"})
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// --- admin ------------------------------------------------------------------

func (s *server) handleState(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := make([]*task, 0, len(s.tasks))
	for _, t := range s.tasks {
		list = append(list, t)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt.Before(list[j].CreatedAt) })
	writeJSON(w, http.StatusOK, map[string]any{
		"runsStarted": s.runs,
		"tasks":       list,
		"aliases":     s.alias,
		"tombstones":  s.tombstone,
		"sessions":    s.sessions,
		"config":      s.cfg,
	})
}

func (s *server) handleConfig(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.Method == http.MethodPost {
		next := s.cfg
		if err := json.NewDecoder(r.Body).Decode(&next); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		next.RequireToken = s.cfg.RequireToken
		if next.FailFor.Duration > 0 {
			next.failForDeadline = time.Now().Add(next.FailFor.Duration)
		} else {
			next.failForDeadline = time.Time{}
		}
		if next.FailFirst > 0 {
			s.requests = 0 // "fail the next N" from now
		}
		s.cfg = next
		s.log.Info("config updated", "config", fmt.Sprintf("%+v", next))
	}
	writeJSON(w, http.StatusOK, s.cfg)
}

func (s *server) handleReset(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range s.tasks {
		if t.cancel != nil {
			t.cancel()
		}
	}
	token := s.cfg.RequireToken
	s.cfg = envConfig()
	s.cfg.RequireToken = token
	s.tasks, s.alias, s.tombstone, s.sessions = map[string]*task{}, map[string]string{}, map[string]bool{}, map[string]int{}
	s.runs, s.requests = 0, 0
	writeJSON(w, http.StatusOK, map[string]string{"status": "reset"})
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"protocolVersion": protocolVersion, "version": "mock-bb/1"})
	})
	mux.HandleFunc("PUT /tasks/{id}", s.gate(s.handlePut))
	mux.HandleFunc("GET /tasks/{id}", s.gate(s.handleTask))
	mux.HandleFunc("GET /tasks/{id}/events", s.gate(s.handleEvents))
	mux.HandleFunc("POST /tasks/{id}/cancel", s.gate(s.handleCancel))
	mux.HandleFunc("GET /admin/state", s.handleState)
	mux.HandleFunc("/admin/config", s.handleConfig)
	mux.HandleFunc("POST /admin/reset", s.handleReset)
	return mux
}

func main() {
	addr := flag.String("addr", envOr("MOCK_BB_ADDR", ":8787"), "listen address")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	s := newServer(ctx, envConfig(), log)
	srv := &http.Server{Addr: *addr, Handler: s.routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	log.Info("mock-bb listening", "addr", *addr, "config", fmt.Sprintf("%+v", s.cfg))
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("listen", "error", err)
		os.Exit(1)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
