package agent

// Copied into upstream/server/pkg/agent/ alongside bb.go. Same pattern as
// museapp_test.go: an httptest fake speaking the real wire contract.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- fake bb ----------------------------------------------------------------

type fakeBBRun struct {
	id      string
	session string
	events  []bbEvent
	changed chan struct{}
	done    bool
}

type fakeBB struct {
	mu sync.Mutex

	token        string
	putFailFirst int // first N PUTs answer 503
	putCode      int // non-zero: every PUT answers this code
	dropAfter    int // close each events connection after N events
	// script drives a newly created run. Nil means: one text event then success.
	script func(f *fakeBB, run *fakeBBRun)

	putCalls  int
	runsMade  int
	runs      map[string]*fakeBBRun
	alias     map[string]string
	tombstone map[string]bool
	cancels   []string
	sinces    []string
	bodies    []bbPutRequest
	authSeen  []string
}

func newFakeBB() *fakeBB {
	return &fakeBB{runs: map[string]*fakeBBRun{}, alias: map[string]string{}, tombstone: map[string]bool{}}
}

func (f *fakeBB) appendEvent(run *fakeBBRun, ev bbEvent) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if run.done {
		return
	}
	ev.ID = int64(len(run.events) + 1)
	run.events = append(run.events, ev)
	if ev.Kind == "result" {
		run.done = true
	}
	close(run.changed)
	run.changed = make(chan struct{})
}

func (f *fakeBB) resolve(id string) string {
	if canon, ok := f.alias[id]; ok {
		return canon
	}
	return id
}

func (f *fakeBB) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(bbHealthResponse{ProtocolVersion: 1, Version: "fake-1"})
	})
	mux.HandleFunc("PUT /tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.putCalls++
		f.authSeen = append(f.authSeen, r.Header.Get("Authorization"))
		if f.putCode != 0 {
			code := f.putCode
			f.mu.Unlock()
			http.Error(w, "refused", code)
			return
		}
		if f.putCalls <= f.putFailFirst {
			f.mu.Unlock()
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		var body bbPutRequest
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		f.bodies = append(f.bodies, body)
		id := r.PathValue("id")
		if f.tombstone[id] {
			f.mu.Unlock()
			http.Error(w, "cancelled before creation", http.StatusConflict)
			return
		}
		canon := f.resolve(id)
		if _, ok := f.runs[canon]; !ok && body.RetryOf != "" {
			if parent, ok := f.runs[f.resolve(body.RetryOf)]; ok {
				f.alias[id] = parent.id
				canon = parent.id
			}
		}
		if run, ok := f.runs[canon]; ok {
			resp := bbPutResponse{TaskID: run.id, Created: false, SessionID: run.session, LastEventID: int64(len(run.events))}
			f.mu.Unlock()
			_ = json.NewEncoder(w).Encode(resp)
			return
		}
		f.runsMade++
		session := body.ResumeSessionID
		if session == "" {
			session = "sess-" + id
		}
		run := &fakeBBRun{id: id, session: session, changed: make(chan struct{})}
		f.runs[id] = run
		script := f.script
		f.mu.Unlock()
		if script == nil {
			script = func(f *fakeBB, run *fakeBBRun) {
				f.appendEvent(run, bbEvent{Kind: "text", Text: "working"})
				f.appendEvent(run, bbEvent{Kind: "result", Status: "succeeded", Summary: "done", PRURL: "https://example/pr/1"})
			}
		}
		go script(f, run)
		_ = json.NewEncoder(w).Encode(bbPutResponse{TaskID: id, Created: true, SessionID: session, ProtocolVersion: 1})
	})
	mux.HandleFunc("GET /tasks/{id}/events", func(w http.ResponseWriter, r *http.Request) {
		since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
		f.mu.Lock()
		f.sinces = append(f.sinces, r.URL.Query().Get("since"))
		run, ok := f.runs[f.resolve(r.PathValue("id"))]
		f.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		flusher.Flush()
		sent := 0
		for {
			f.mu.Lock()
			pending := append([]bbEvent(nil), run.events[min(int(since), len(run.events)):]...)
			done := run.done
			changed := run.changed
			f.mu.Unlock()
			for _, ev := range pending {
				raw, _ := json.Marshal(ev)
				fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", ev.ID, ev.Kind, raw)
				flusher.Flush()
				since = ev.ID
				sent++
				if f.dropAfter > 0 && sent >= f.dropAfter && ev.Kind != "result" {
					return // simulate a dropped connection
				}
			}
			if done {
				return
			}
			select {
			case <-changed:
			case <-r.Context().Done():
				return
			}
		}
	})
	mux.HandleFunc("POST /tasks/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		f.mu.Lock()
		f.cancels = append(f.cancels, id)
		run, ok := f.runs[f.resolve(id)]
		if !ok {
			f.tombstone[id] = true
		}
		f.mu.Unlock()
		if ok {
			f.appendEvent(run, bbEvent{Kind: "result", Status: "cancelled"})
		}
		_, _ = w.Write([]byte(`{"status":"cancelled"}`))
	})
	return mux
}

func (f *fakeBB) snapshot() (puts, runs int, cancels, sinces []string, bodies []bbPutRequest) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.putCalls, f.runsMade, append([]string(nil), f.cancels...), append([]string(nil), f.sinces...), append([]bbPutRequest(nil), f.bodies...)
}

// --- helpers ----------------------------------------------------------------

func startFakeBB(t *testing.T, f *fakeBB) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	t.Setenv(bbEnvEndpoint, srv.URL)
	t.Setenv(bbEnvToken, "test-token")
	t.Setenv(bbEnvPutAttempts, "")
	t.Setenv(bbEnvSilenceTimeout, "")
	return srv
}

func fastBBTuning(t *testing.T) {
	t.Helper()
	saved, savedShutdown := bbTuning, bbShuttingDownFn
	bbTuning = bbTunables{
		putAttempts:    5,
		backoffBase:    5 * time.Millisecond,
		backoffMax:     20 * time.Millisecond,
		silenceTimeout: 2 * time.Second,
		reconnectBase:  5 * time.Millisecond,
		reconnectMax:   20 * time.Millisecond,
		shutdownGrace:  20 * time.Millisecond,
		cancelTimeout:  2 * time.Second,
	}
	bbShuttingDownFn = func() bool { return false }
	t.Cleanup(func() { bbTuning, bbShuttingDownFn = saved, savedShutdown })
}

func newTestBB(taskID string, env map[string]string) *bbBackend {
	b, _ := New("bb", Config{TaskID: taskID, Env: env})
	return b.(*bbBackend)
}

func collectBB(t *testing.T, s *Session, timeout time.Duration) ([]Message, Result) {
	t.Helper()
	var msgs []Message
	deadline := time.After(timeout)
	for {
		select {
		case m, ok := <-s.Messages:
			if !ok {
				select {
				case r := <-s.Result:
					return msgs, r
				case <-deadline:
					t.Fatal("timed out waiting for result")
				}
			}
			msgs = append(msgs, m)
		case <-deadline:
			t.Fatalf("timed out waiting for session to finish; got %d messages", len(msgs))
		}
	}
}

func textsOf(msgs []Message) []string {
	var out []string
	for _, m := range msgs {
		if m.Type == MessageText {
			out = append(out, m.Content)
		}
	}
	return out
}

// --- tests ------------------------------------------------------------------

func TestBBRegisteredInNew(t *testing.T) {
	b, err := New("bb", Config{})
	if err != nil {
		t.Fatalf("New(bb): %v", err)
	}
	if _, ok := b.(*bbBackend); !ok {
		t.Fatalf("New(bb) returned %T", b)
	}
	if LaunchHeader("bb") == "" {
		t.Fatal("bb has no launch header")
	}
}

func TestBBExecuteSuccess(t *testing.T) {
	fastBBTuning(t)
	f := newFakeBB()
	startFakeBB(t, f)

	s, err := newTestBB("task-ok", nil).Execute(context.Background(), "fix it", ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	msgs, res := collectBB(t, s, 5*time.Second)
	if res.Status != "completed" {
		t.Fatalf("status = %q (%s), want completed", res.Status, res.Error)
	}
	if !strings.Contains(res.Output, "done") || !strings.Contains(res.Output, "https://example/pr/1") {
		t.Fatalf("output %q lacks summary/PR link", res.Output)
	}
	if res.SessionID != "sess-task-ok" {
		t.Fatalf("session = %q", res.SessionID)
	}
	if got := textsOf(msgs); len(got) != 1 || got[0] != "working" {
		t.Fatalf("texts = %v", got)
	}
	if msgs[0].Type != MessageStatus || msgs[0].SessionID != "sess-task-ok" {
		t.Fatalf("first message should pin the session, got %+v", msgs[0])
	}
	if !s.TerminalObserved() {
		t.Fatal("TerminalObserved false after result")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.authSeen[0] != "Bearer test-token" {
		t.Fatalf("auth header = %q", f.authSeen[0])
	}
}

func TestBBPutRetriesUntilOK(t *testing.T) {
	fastBBTuning(t)
	f := newFakeBB()
	f.putFailFirst = 3
	startFakeBB(t, f)

	s, _ := newTestBB("task-retry", nil).Execute(context.Background(), "p", ExecOptions{})
	_, res := collectBB(t, s, 5*time.Second)
	if res.Status != "completed" {
		t.Fatalf("status = %q (%s)", res.Status, res.Error)
	}
	puts, runs, _, _, _ := f.snapshot()
	if puts != 4 || runs != 1 {
		t.Fatalf("puts=%d runs=%d, want 4 and 1", puts, runs)
	}
}

func TestBBPutGivesUpAfterNAttempts(t *testing.T) {
	fastBBTuning(t)
	f := newFakeBB()
	f.putFailFirst = 1 << 30
	startFakeBB(t, f)
	t.Setenv(bbEnvPutAttempts, "3")

	s, _ := newTestBB("task-down", nil).Execute(context.Background(), "p", ExecOptions{})
	_, res := collectBB(t, s, 5*time.Second)
	if res.Status != "failed" || !strings.Contains(res.Error, "after 3 attempts") || !strings.Contains(res.Error, "503") {
		t.Fatalf("got %q / %q, want failed after 3 attempts", res.Status, res.Error)
	}
	if puts, runs, _, _, _ := f.snapshot(); puts != 3 || runs != 0 {
		t.Fatalf("puts=%d runs=%d", puts, runs)
	}
}

func TestBBPutPermanentErrorFailsFast(t *testing.T) {
	fastBBTuning(t)
	f := newFakeBB()
	f.putCode = http.StatusBadRequest
	startFakeBB(t, f)

	s, _ := newTestBB("task-bad", nil).Execute(context.Background(), "p", ExecOptions{})
	_, res := collectBB(t, s, 5*time.Second)
	if res.Status != "failed" || !strings.Contains(res.Error, "rejected") {
		t.Fatalf("got %q / %q", res.Status, res.Error)
	}
	if puts, _, _, _, _ := f.snapshot(); puts != 1 {
		t.Fatalf("puts=%d, want 1 (no retry on 400)", puts)
	}
}

func TestBBDuplicatePutStartsOneRun(t *testing.T) {
	fastBBTuning(t)
	f := newFakeBB()
	release := make(chan struct{})
	f.script = func(f *fakeBB, run *fakeBBRun) {
		f.appendEvent(run, bbEvent{Kind: "text", Text: "a"})
		<-release
		f.appendEvent(run, bbEvent{Kind: "result", Status: "succeeded", Summary: "ok"})
	}
	startFakeBB(t, f)

	// Same Multica task id from two backends: a daemon restart mid-run, or the
	// same task delivered twice.
	s1, _ := newTestBB("task-dup", nil).Execute(context.Background(), "p", ExecOptions{})
	s2, _ := newTestBB("task-dup", nil).Execute(context.Background(), "p", ExecOptions{})
	close(release)
	_, r1 := collectBB(t, s1, 5*time.Second)
	m2, r2 := collectBB(t, s2, 5*time.Second)
	if r1.Status != "completed" || r2.Status != "completed" {
		t.Fatalf("statuses %q %q", r1.Status, r2.Status)
	}
	if got := textsOf(m2); len(got) != 1 || got[0] != "a" {
		t.Fatalf("reattached stream texts = %v, want [a] replayed from since=0", got)
	}
	if puts, runs, _, _, _ := f.snapshot(); puts != 2 || runs != 1 {
		t.Fatalf("puts=%d runs=%d, want 2 PUTs and exactly 1 run", puts, runs)
	}
}

func TestBBRetryChildReattachesToParentRun(t *testing.T) {
	fastBBTuning(t)
	f := newFakeBB()
	release := make(chan struct{})
	f.script = func(f *fakeBB, run *fakeBBRun) {
		f.appendEvent(run, bbEvent{Kind: "text", Text: "first"})
		<-release
		f.appendEvent(run, bbEvent{Kind: "result", Status: "succeeded", Summary: "ok"})
	}
	startFakeBB(t, f)

	ctx1, cancel1 := context.WithCancel(context.Background())
	bbShuttingDownFn = func() bool { return true } // attempt 1 dies with the daemon
	s1, _ := newTestBB("attempt-1", nil).Execute(ctx1, "p", ExecOptions{})
	for m := range s1.Messages {
		if m.Type == MessageText {
			break
		}
	}
	cancel1()
	if _, r := collectBB(t, s1, 5*time.Second); r.Status != "aborted" {
		t.Fatalf("attempt 1 status %q, want aborted (left running)", r.Status)
	}
	bbShuttingDownFn = func() bool { return false }

	// Multica's runtime_recovery retry: a new task id whose parent is attempt-1
	// (and, for a 3-attempt chain, whose grandparent is the run owner).
	s2, _ := newTestBB("attempt-2", map[string]string{BBEnvParentTaskID: "attempt-1", BBEnvAttempt: "2"}).Execute(context.Background(), "p", ExecOptions{})
	time.Sleep(50 * time.Millisecond)
	close(release)
	m2, r2 := collectBB(t, s2, 5*time.Second)
	if r2.Status != "completed" {
		t.Fatalf("attempt 2 status %q (%s)", r2.Status, r2.Error)
	}
	if got := textsOf(m2); len(got) != 1 || got[0] != "first" {
		t.Fatalf("attempt 2 texts = %v", got)
	}
	s3, _ := newTestBB("attempt-3", map[string]string{BBEnvParentTaskID: "attempt-2"}).Execute(context.Background(), "p", ExecOptions{})
	if _, r3 := collectBB(t, s3, 5*time.Second); r3.Status != "completed" {
		t.Fatalf("attempt 3 status %q", r3.Status)
	}
	_, runs, cancels, _, bodies := f.snapshot()
	if runs != 1 {
		t.Fatalf("runs = %d, want exactly 1 across the retry chain", runs)
	}
	if len(cancels) != 0 {
		t.Fatalf("shutdown must not cancel the bb run; cancels = %v", cancels)
	}
	if bodies[1].RetryOf != "attempt-1" || bodies[1].Attempt != 2 {
		t.Fatalf("retry PUT body = %+v", bodies[1])
	}
}

func TestBBReconnectResumesWithoutDupesOrGaps(t *testing.T) {
	fastBBTuning(t)
	f := newFakeBB()
	f.dropAfter = 2
	f.script = func(f *fakeBB, run *fakeBBRun) {
		for i := 1; i <= 9; i++ {
			f.appendEvent(run, bbEvent{Kind: "text", Text: strconv.Itoa(i)})
			time.Sleep(2 * time.Millisecond)
		}
		f.appendEvent(run, bbEvent{Kind: "result", Status: "succeeded"})
	}
	startFakeBB(t, f)

	s, _ := newTestBB("task-flaky", nil).Execute(context.Background(), "p", ExecOptions{})
	msgs, res := collectBB(t, s, 5*time.Second)
	if res.Status != "completed" {
		t.Fatalf("status %q (%s)", res.Status, res.Error)
	}
	got := strings.Join(textsOf(msgs), ",")
	if got != "1,2,3,4,5,6,7,8,9" {
		t.Fatalf("texts = %s, want 1..9 exactly once in order", got)
	}
	if res.Output != "123456789" {
		t.Fatalf("output %q", res.Output)
	}
	_, _, _, sinces, _ := f.snapshot()
	if len(sinces) < 3 || sinces[0] != "0" {
		t.Fatalf("expected several reconnects starting at since=0, got %v", sinces)
	}
	for i := 1; i < len(sinces); i++ {
		a, _ := strconv.Atoi(sinces[i-1])
		b, _ := strconv.Atoi(sinces[i])
		if b < a {
			t.Fatalf("since went backwards: %v", sinces)
		}
	}
}

func TestBBReplayedEventsAreDeduplicated(t *testing.T) {
	fastBBTuning(t)
	r := &bbRun{ctx: context.Background(), msgCh: make(chan Message, 16), tuning: bbTuning}
	for _, id := range []int64{1, 2, 2, 1, 3} {
		raw, _ := json.Marshal(bbEvent{ID: id, Kind: "text", Text: strconv.FormatInt(id, 10)})
		r.dispatch("", string(raw))
	}
	close(r.msgCh)
	var got []string
	for m := range r.msgCh {
		got = append(got, m.Content)
	}
	if strings.Join(got, ",") != "1,2,3" {
		t.Fatalf("got %v", got)
	}
}

func TestBBHeartbeatsKeepRunAlive(t *testing.T) {
	fastBBTuning(t)
	bbTuning.silenceTimeout = 150 * time.Millisecond
	f := newFakeBB()
	f.script = func(f *fakeBB, run *fakeBBRun) {
		// 600ms of work, 4x the silence window, carried only by heartbeats.
		for i := 0; i < 20; i++ {
			f.appendEvent(run, bbEvent{Kind: "heartbeat"})
			time.Sleep(30 * time.Millisecond)
		}
		f.appendEvent(run, bbEvent{Kind: "result", Status: "succeeded", Summary: "long job"})
	}
	startFakeBB(t, f)

	s, _ := newTestBB("task-long", nil).Execute(context.Background(), "p", ExecOptions{})
	msgs, res := collectBB(t, s, 5*time.Second)
	if res.Status != "completed" {
		t.Fatalf("status %q (%s): heartbeats should have kept the run alive", res.Status, res.Error)
	}
	beats := 0
	for _, m := range msgs {
		if m.Type == MessageStatus && m.SessionID == "" {
			beats++
		}
	}
	if beats != 20 {
		t.Fatalf("forwarded %d heartbeats, want 20 (each resets the daemon idle watchdog)", beats)
	}
}

func TestBBSilenceTripsTimeoutWithoutCancellingRun(t *testing.T) {
	fastBBTuning(t)
	bbTuning.silenceTimeout = 150 * time.Millisecond
	f := newFakeBB()
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })
	f.script = func(f *fakeBB, run *fakeBBRun) {
		f.appendEvent(run, bbEvent{Kind: "text", Text: "started"})
		<-block // then nothing: no heartbeats, connection held open
	}
	startFakeBB(t, f)

	start := time.Now()
	s, _ := newTestBB("task-silent", nil).Execute(context.Background(), "p", ExecOptions{})
	_, res := collectBB(t, s, 5*time.Second)
	if res.Status != "timeout" || !strings.Contains(res.Error, "no events") {
		t.Fatalf("got %q / %q, want timeout", res.Status, res.Error)
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("silence detection took %s", el)
	}
	if _, _, cancels, _, _ := f.snapshot(); len(cancels) != 0 {
		t.Fatalf("silence must leave the bb run for the retry to reattach; cancels = %v", cancels)
	}
}

func TestBBCancelPropagates(t *testing.T) {
	fastBBTuning(t)
	f := newFakeBB()
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })
	f.script = func(f *fakeBB, run *fakeBBRun) {
		f.appendEvent(run, bbEvent{Kind: "text", Text: "busy"})
		<-block
	}
	startFakeBB(t, f)

	ctx, cancel := context.WithCancel(context.Background())
	s, _ := newTestBB("task-cancel", nil).Execute(ctx, "p", ExecOptions{})
	for m := range s.Messages {
		if m.Type == MessageText {
			break
		}
	}
	cancel()
	_, res := collectBB(t, s, 5*time.Second)
	if res.Status != "cancelled" {
		t.Fatalf("status %q, want cancelled", res.Status)
	}
	if _, _, cancels, _, _ := f.snapshot(); len(cancels) != 1 || cancels[0] != "task-cancel" {
		t.Fatalf("cancels = %v, want [task-cancel]", cancels)
	}
}

func TestBBCancelDuringPutTombstonesTask(t *testing.T) {
	fastBBTuning(t)
	bbTuning.backoffBase = 200 * time.Millisecond
	f := newFakeBB()
	f.putFailFirst = 1 << 30
	startFakeBB(t, f)

	ctx, cancel := context.WithCancel(context.Background())
	s, _ := newTestBB("task-early", nil).Execute(ctx, "p", ExecOptions{})
	time.Sleep(50 * time.Millisecond)
	cancel()
	_, res := collectBB(t, s, 5*time.Second)
	if res.Status != "cancelled" {
		t.Fatalf("status %q", res.Status)
	}
	if _, _, cancels, _, _ := f.snapshot(); len(cancels) != 1 || cancels[0] != "task-early" {
		t.Fatalf("cancels = %v", cancels)
	}
}

func TestBBAgentTimeoutCancelsRemote(t *testing.T) {
	fastBBTuning(t)
	f := newFakeBB()
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })
	f.script = func(f *fakeBB, run *fakeBBRun) { <-block }
	startFakeBB(t, f)

	s, _ := newTestBB("task-cap", nil).Execute(context.Background(), "p", ExecOptions{Timeout: 100 * time.Millisecond})
	_, res := collectBB(t, s, 5*time.Second)
	if res.Status != "timeout" {
		t.Fatalf("status %q", res.Status)
	}
	if _, _, cancels, _, _ := f.snapshot(); len(cancels) != 1 {
		t.Fatalf("operator timeout should stop the bb run; cancels = %v", cancels)
	}
}

func TestBBResumeSessionIDAndMetadataPassedThrough(t *testing.T) {
	fastBBTuning(t)
	f := newFakeBB()
	startFakeBB(t, f)

	env := map[string]string{
		BBEnvIssueID:         "issue-uuid",
		BBEnvIssueIdentifier: "ENG-7",
		BBEnvRepos:           `[{"url":"https://github.com/acme/app","ref":"main"}]`,
		bbEnvEndpoint:        "http://attacker.invalid", // custom_env must not redirect us
	}
	s, _ := newTestBB("task-resume", env).Execute(context.Background(), "continue please", ExecOptions{
		ResumeSessionID:    "do-session-42",
		SystemPrompt:       "brief",
		Model:              "m1",
		TaskToken:          "mat_abc",
		MulticaServerURL:   "http://multica",
		MulticaWorkspaceID: "ws-1",
	})
	_, res := collectBB(t, s, 5*time.Second)
	if res.Status != "completed" || res.SessionID != "do-session-42" {
		t.Fatalf("status %q session %q", res.Status, res.SessionID)
	}
	_, _, _, _, bodies := f.snapshot()
	b := bodies[0]
	if b.ResumeSessionID != "do-session-42" || b.Prompt != "continue please" || b.SystemPrompt != "brief" || b.Model != "m1" {
		t.Fatalf("body = %+v", b)
	}
	if b.TaskID != "task-resume" || b.MulticaTaskID != "task-resume" || b.RetryOf != "" {
		t.Fatalf("ids = %+v", b)
	}
	if b.Issue == nil || b.Issue.Identifier != "ENG-7" || len(b.Repos) != 1 || b.Repos[0].Ref != "main" {
		t.Fatalf("metadata = %+v", b)
	}
	if b.Multica.TaskToken != "mat_abc" || b.Multica.WorkspaceID != "ws-1" {
		t.Fatalf("multica ctx = %+v", b.Multica)
	}
}

func TestBBSecondTurnUsesDistinctKey(t *testing.T) {
	fastBBTuning(t)
	f := newFakeBB()
	startFakeBB(t, f)
	b := newTestBB("task-turns", map[string]string{BBEnvParentTaskID: "older"})
	for i := 0; i < 2; i++ {
		s, _ := b.Execute(context.Background(), "p", ExecOptions{})
		collectBB(t, s, 5*time.Second)
	}
	_, runs, _, _, bodies := f.snapshot()
	if runs != 2 || bodies[1].TaskID != "task-turns:turn2" || bodies[1].RetryOf != "" {
		t.Fatalf("runs=%d second body=%+v", runs, bodies[1])
	}
}

func TestBBRemoteFailureAndCancelMapping(t *testing.T) {
	for _, tc := range []struct{ status, want string }{{"failed", "failed"}, {"cancelled", "cancelled"}} {
		t.Run(tc.status, func(t *testing.T) {
			fastBBTuning(t)
			f := newFakeBB()
			f.script = func(f *fakeBB, run *fakeBBRun) {
				f.appendEvent(run, bbEvent{Kind: "error", Message: "tests red"})
				f.appendEvent(run, bbEvent{Kind: "result", Status: tc.status, Error: "boom"})
			}
			startFakeBB(t, f)
			s, _ := newTestBB("task-"+tc.status, nil).Execute(context.Background(), "p", ExecOptions{})
			msgs, res := collectBB(t, s, 5*time.Second)
			if res.Status != tc.want {
				t.Fatalf("status %q", res.Status)
			}
			sawErr := false
			for _, m := range msgs {
				sawErr = sawErr || (m.Type == MessageError && m.Content == "tests red")
			}
			if !sawErr {
				t.Fatal("error event not forwarded")
			}
		})
	}
}

func TestBBExecuteValidation(t *testing.T) {
	t.Setenv(bbEnvEndpoint, "")
	if _, err := newTestBB("t", nil).Execute(context.Background(), "p", ExecOptions{}); err == nil {
		t.Fatal("missing endpoint should error")
	}
	t.Setenv(bbEnvEndpoint, "http://x")
	if _, err := newTestBB("t", nil).Execute(context.Background(), "  ", ExecOptions{}); err == nil {
		t.Fatal("empty prompt should error")
	}
	if _, err := newTestBB("", nil).Execute(context.Background(), "p", ExecOptions{}); err == nil {
		t.Fatal("missing task id should error")
	}
}

func TestProbeBB(t *testing.T) {
	f := newFakeBB()
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	if v, err := ProbeBB(context.Background(), srv.URL, ""); err != nil || v != "fake-1" {
		t.Fatalf("probe = %q, %v", v, err)
	}
	skew := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"protocolVersion":2,"version":"x"}`))
	}))
	defer skew.Close()
	if _, err := ProbeBB(context.Background(), skew.URL, ""); err == nil || !strings.Contains(err.Error(), "protocol skew") {
		t.Fatalf("skew err = %v", err)
	}
}

// TestBBContractAgainstLiveServer drives the real backend against a running
// mock-bb (or a staging bb that exposes the same /admin endpoints). CI starts
// mock-bb and sets BB_CONTRACT_URL; locally:
//
//	go run ./mock-bb & BB_CONTRACT_URL=http://localhost:8787 make test
func TestBBContractAgainstLiveServer(t *testing.T) {
	base := strings.TrimRight(os.Getenv("BB_CONTRACT_URL"), "/")
	if base == "" {
		t.Skip("BB_CONTRACT_URL not set")
	}
	fastBBTuning(t)
	bbTuning.silenceTimeout = 10 * time.Second
	t.Setenv(bbEnvEndpoint, base)
	t.Setenv(bbEnvToken, os.Getenv("BB_CONTRACT_TOKEN"))
	t.Setenv(bbEnvPutAttempts, "")
	t.Setenv(bbEnvSilenceTimeout, "")
	admin := func(method, path, body string) map[string]any {
		req, _ := http.NewRequest(method, base+path, strings.NewReader(body))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out
	}
	admin(http.MethodPost, "/admin/reset", "")
	// Everything at once: two 503s, a PUT that is persisted but never answered,
	// and an events stream that drops every 2 events.
	admin(http.MethodPost, "/admin/config", `{"failFirst":2,"acceptThenDrop":1,"dropAfter":2,"stepDelay":"20ms","resultAfter":7,"heartbeatEvery":"50ms","resultStatus":"succeeded"}`)

	id := fmt.Sprintf("contract-%d", time.Now().UnixNano())
	s, err := newTestBB(id, nil).Execute(context.Background(), "contract test", ExecOptions{ResumeSessionID: "sess-contract"})
	if err != nil {
		t.Fatal(err)
	}
	msgs, res := collectBB(t, s, 30*time.Second)
	if res.Status != "completed" || res.SessionID != "sess-contract" {
		t.Fatalf("status %q session %q err %q", res.Status, res.SessionID, res.Error)
	}
	state := admin(http.MethodGet, "/admin/state", "")
	if runs := state["runsStarted"].(float64); runs != 1 {
		t.Fatalf("mock started %v runs, want 1", runs)
	}
	tasks := state["tasks"].([]any)
	events := int(tasks[0].(map[string]any)["eventCount"].(float64))
	// Every bb event except the terminal result (which becomes the Result)
	// reached the daemon exactly once. MessageLog entries are our own PUT-retry
	// notices: two 503s plus the accepted-then-dropped PUT.
	forwarded, retries := 0, 0
	for _, m := range msgs {
		if m.Type == MessageStatus && m.SessionID != "" {
			continue // the session pin, not a bb event
		}
		if m.Type == MessageLog {
			retries++
		} else {
			forwarded++
		}
	}
	if forwarded != events-1 || retries != 3 {
		t.Fatalf("forwarded %d messages for %d bb events (+%d retry notices)", forwarded, events, retries)
	}
}
