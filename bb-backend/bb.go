package agent

// This file is NOT part of upstream Multica. It is copied into
// upstream/server/pkg/agent/ at build time by scripts/apply-overlay.sh (see the
// repo README) and registered as the "bb" backend by patches/register-bb.patch.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// bbBackend implements Backend by delegating to bb, a remote coding agent that
// runs on Cloudflare Workers / Durable Objects. Like museapp there is no local
// CLI: the daemon advertises a "bb" runtime exactly when MULTICA_BB_ENDPOINT is
// set, and Execute hands the task to bb over HTTP and streams its events back.
//
// Wire contract (v1, see docs/bb-contract.md):
//
//	GET  /health                         -> {protocolVersion, version}
//	PUT  /tasks/{id}                     idempotent create (200 once durable)
//	GET  /tasks/{id}/events?since=N      SSE stream of ordered events
//	POST /tasks/{id}/cancel              idempotent cancel
//
// Exactly-one-run guarantees:
//
//   - The idempotency key is the Multica task ID. A repeated PUT for the same
//     ID (backend retry, daemon restart mid-PUT) returns the existing run.
//   - Multica's automatic retries (runtime_offline, runtime_recovery, timeout)
//     create a NEW task row whose parent_task_id points at the failed attempt.
//     The daemon patch forwards that as MULTICA_BB_PARENT_TASK_ID and we send it
//     as retryOf: bb resolves it to the existing run, records the new ID as an
//     alias and never starts a second run. A manual "rerun" has no parent and
//     deliberately starts a fresh run.
//   - On stream disconnect we reconnect with since=<last seen id> and drop any
//     event whose id we have already forwarded, so nothing is duplicated or lost.
//
// Endpoint and token are read only from the daemon process environment, never
// from cfg.Env (which carries user-editable custom_env) — same rule as museapp.
// Task metadata (issue, repos, retry lineage) does come from cfg.Env, but only
// under MULTICA_* keys, which the daemon refuses to let custom_env override
// (isBlockedEnvKey).
type bbBackend struct {
	cfg Config
	// turns counts Execute calls on this backend instance. The daemon builds one
	// backend per task, so a second call is a same-task follow-up turn (e.g. a
	// worktree repair) and must not collapse into the first run.
	turns atomic.Int32
}

const bbProtocolVersion = 1

// ErrBBProtocolSkew means bb speaks a different wire protocol version. The
// daemon treats it as a deterministic (demotable) probe failure.
var ErrBBProtocolSkew = errors.New("bb backend: protocol skew")

const (
	bbEnvEndpoint       = "MULTICA_BB_ENDPOINT"
	bbEnvToken          = "MULTICA_BB_TOKEN"
	bbEnvPutAttempts    = "MULTICA_BB_PUT_ATTEMPTS"
	bbEnvSilenceTimeout = "MULTICA_BB_SILENCE_TIMEOUT"

	// Task metadata the daemon patch places in cfg.Env (see daemon_bb.go).
	BBEnvIssueID         = "MULTICA_BB_ISSUE_ID"
	BBEnvIssueIdentifier = "MULTICA_BB_ISSUE_IDENTIFIER"
	BBEnvChatSessionID   = "MULTICA_BB_CHAT_SESSION_ID"
	BBEnvParentTaskID    = "MULTICA_BB_PARENT_TASK_ID"
	BBEnvAttempt         = "MULTICA_BB_ATTEMPT"
	BBEnvRepos           = "MULTICA_BB_REPOS"
)

// bbTunables groups every timing knob so tests can shrink them in one place.
type bbTunables struct {
	putAttempts    int           // PUT attempts before the task fails
	backoffBase    time.Duration // first PUT retry delay (doubles per attempt)
	backoffMax     time.Duration // cap on a single PUT retry delay
	silenceTimeout time.Duration // no bb event (heartbeats included) for this long => timeout
	reconnectBase  time.Duration // first stream reconnect delay
	reconnectMax   time.Duration // cap on a stream reconnect delay
	shutdownGrace  time.Duration // how long to wait for the shutdown-signal flag after ctx is cancelled
	cancelTimeout  time.Duration // bound on POST /cancel
}

// bbTuning holds the defaults. bb heartbeats are expected every ~15-30s, so a
// 10 minute silence window rides out several missed beats and short network
// partitions while still failing a dead run long before the daemon's generic
// 2h idle watchdog would.
var bbTuning = bbTunables{
	putAttempts:    8,
	backoffBase:    500 * time.Millisecond,
	backoffMax:     30 * time.Second,
	silenceTimeout: 10 * time.Minute,
	reconnectBase:  250 * time.Millisecond,
	reconnectMax:   10 * time.Second,
	shutdownGrace:  250 * time.Millisecond,
	cancelTimeout:  15 * time.Second,
}

// bbHTTPClient serves the short request/response calls. The events stream uses
// bbStreamClient, which has no overall timeout (the stream is long-lived and is
// bounded by ctx and the silence watchdog instead).
var (
	bbHTTPClient   = &http.Client{Timeout: 30 * time.Second}
	bbStreamClient = &http.Client{}
)

func init() {
	launchHeaders["bb"] = "bb (remote HTTP)"
}

// --- shutdown detection ---------------------------------------------------
//
// Inside Execute a cancelled ctx is ambiguous: the server cancelled the task
// (user hit Cancel), or the daemon is shutting down (SIGTERM on a rolling
// deploy / `docker stop`). The two need opposite treatment: a user cancel must
// stop the bb run, while a shutdown must leave it running so the retry Multica
// creates (runtime_recovery) can reattach to it. The daemon exits via
// signal.NotifyContext(SIGINT, SIGTERM); Go delivers a signal to every
// registered channel, so we observe the same signal here.

var (
	bbShutdownSeen   atomic.Bool
	bbShutdownOnce   sync.Once
	bbShuttingDownFn = func() bool { return bbShutdownSeen.Load() }
)

func bbWatchShutdownSignals() {
	bbShutdownOnce.Do(func() {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
		go func() {
			<-ch
			bbShutdownSeen.Store(true)
		}()
	})
}

// --- wire types -------------------------------------------------------------

type bbIssue struct {
	ID         string `json:"id,omitempty"`
	Identifier string `json:"identifier,omitempty"`
}

type bbRepo struct {
	URL         string `json:"url"`
	Ref         string `json:"ref,omitempty"`
	Description string `json:"description,omitempty"`
}

type bbMulticaContext struct {
	ServerURL   string `json:"serverUrl,omitempty"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	// TaskToken is the task-scoped mat_ token so bb can read the issue and post
	// comments with this task's identity.
	TaskToken string `json:"taskToken,omitempty"`
}

type bbPutRequest struct {
	ProtocolVersion int              `json:"protocolVersion"`
	TaskID          string           `json:"taskId"`
	MulticaTaskID   string           `json:"multicaTaskId"`
	RetryOf         string           `json:"retryOf,omitempty"`
	Attempt         int              `json:"attempt,omitempty"`
	Prompt          string           `json:"prompt"`
	SystemPrompt    string           `json:"systemPrompt,omitempty"`
	ResumeSessionID string           `json:"resumeSessionId,omitempty"`
	Model           string           `json:"model,omitempty"`
	Issue           *bbIssue         `json:"issue,omitempty"`
	ChatSessionID   string           `json:"chatSessionId,omitempty"`
	Repos           []bbRepo         `json:"repos,omitempty"`
	Multica         bbMulticaContext `json:"multica"`
}

type bbPutResponse struct {
	// TaskID is the canonical run ID. It differs from the requested ID when bb
	// resolved retryOf to an existing run; every later call uses it.
	TaskID          string `json:"taskId"`
	Created         bool   `json:"created"`
	Status          string `json:"status,omitempty"`
	SessionID       string `json:"sessionId,omitempty"`
	LastEventID     int64  `json:"lastEventId,omitempty"`
	ProtocolVersion int    `json:"protocolVersion,omitempty"`
}

type bbEvent struct {
	ID        int64          `json:"id"`
	Kind      string         `json:"kind"`
	Text      string         `json:"text,omitempty"`
	CallID    string         `json:"callId,omitempty"`
	Tool      string         `json:"tool,omitempty"`
	Input     map[string]any `json:"input,omitempty"`
	Output    string         `json:"output,omitempty"`
	Phase     string         `json:"phase,omitempty"`  // tool_call: start | end
	Status    string         `json:"status,omitempty"` // result: succeeded | failed | cancelled
	Summary   string         `json:"summary,omitempty"`
	PRURL     string         `json:"prUrl,omitempty"`
	SessionID string         `json:"sessionId,omitempty"`
	Error     string         `json:"error,omitempty"`
	Message   string         `json:"message,omitempty"`
}

type bbHealthResponse struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Version         string `json:"version"`
}

type bbHTTPError struct {
	Code int
	Body string
	Op   string
}

func (e *bbHTTPError) Error() string {
	return fmt.Sprintf("bb backend: %s: HTTP %d: %s", e.Op, e.Code, e.Body)
}

// permanent reports whether retrying cannot help: a 4xx other than the
// throttling/timeouts that explicitly invite a retry.
func (e *bbHTTPError) permanent() bool {
	if e.Code < 400 || e.Code >= 500 {
		return false
	}
	switch e.Code {
	case http.StatusRequestTimeout, http.StatusTooEarly, http.StatusTooManyRequests:
		return false
	}
	return true
}

type bbEndpoint struct {
	base  string
	token string
}

func resolveBBEndpoint() (bbEndpoint, error) {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv(bbEnvEndpoint)), "/")
	if base == "" {
		return bbEndpoint{}, fmt.Errorf("bb backend: %s is not set", bbEnvEndpoint)
	}
	if _, err := url.ParseRequestURI(base); err != nil {
		return bbEndpoint{}, fmt.Errorf("bb backend: invalid %s %q: %w", bbEnvEndpoint, base, err)
	}
	return bbEndpoint{base: base, token: strings.TrimSpace(os.Getenv(bbEnvToken))}, nil
}

func bbTuningFromEnv() bbTunables {
	t := bbTuning
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(bbEnvPutAttempts))); err == nil && v > 0 {
		t.putAttempts = v
	}
	if v, err := time.ParseDuration(strings.TrimSpace(os.Getenv(bbEnvSilenceTimeout))); err == nil && v > 0 {
		t.silenceTimeout = v
	}
	return t
}

func bbTaskPath(id, suffix string) string {
	return "/tasks/" + url.PathEscape(id) + suffix
}

// ProbeBB checks that bb is reachable and speaks protocol v1. It backs the
// daemon's runtime availability probe (there is no binary to --version).
func ProbeBB(ctx context.Context, endpoint, token string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(endpoint), "/")
	if _, err := url.ParseRequestURI(base); err != nil {
		return "", fmt.Errorf("bb backend: invalid endpoint %q: %w", base, err)
	}
	var health bbHealthResponse
	if err := bbDo(ctx, bbHTTPClient, bbEndpoint{base: base, token: token}, http.MethodGet, "/health", nil, &health); err != nil {
		return "", err
	}
	if health.ProtocolVersion != bbProtocolVersion {
		return "", fmt.Errorf("%w: bb speaks v%d, backend implements v%d", ErrBBProtocolSkew, health.ProtocolVersion, bbProtocolVersion)
	}
	if health.Version == "" {
		health.Version = "unknown"
	}
	return health.Version, nil
}

func bbDo(ctx context.Context, client *http.Client, ep bbEndpoint, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("bb backend: encode request: %w", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, ep.base+path, reader)
	if err != nil {
		return fmt.Errorf("bb backend: build request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if ep.token != "" {
		req.Header.Set("Authorization", "Bearer "+ep.token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("bb backend: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("bb backend: read %s %s: %w", method, path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &bbHTTPError{Code: resp.StatusCode, Body: strings.TrimSpace(string(raw)), Op: method + " " + path}
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("bb backend: decode %s %s: %w", method, path, err)
	}
	return nil
}

// --- Execute ----------------------------------------------------------------

func (b *bbBackend) Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error) {
	if strings.TrimSpace(prompt) == "" {
		return nil, errors.New("bb prompt must not be empty")
	}
	ep, err := resolveBBEndpoint()
	if err != nil {
		return nil, err
	}
	taskID := strings.TrimSpace(b.cfg.TaskID)
	if taskID == "" {
		taskID = strings.TrimSpace(b.cfg.Env["MULTICA_TASK_ID"])
	}
	if taskID == "" {
		return nil, errors.New("bb backend: no Multica task id; bb requires one as the idempotency key")
	}
	logger := b.cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	bbWatchShutdownSignals()

	key := taskID
	retryOf := strings.TrimSpace(b.cfg.Env[BBEnvParentTaskID])
	if turn := b.turns.Add(1); turn > 1 {
		// A same-task follow-up turn is a new bb run continuing the session,
		// not a retry of the first one.
		key = fmt.Sprintf("%s:turn%d", taskID, turn)
		retryOf = ""
	}

	runCtx, cancel := runContext(ctx, opts.Timeout)
	r := &bbRun{
		ep:      ep,
		tuning:  bbTuningFromEnv(),
		logger:  logger.With("provider", "bb", "bb_task_id", key),
		opts:    opts,
		parent:  ctx,
		ctx:     runCtx,
		msgCh:   make(chan Message, 256),
		request: b.buildRequest(key, taskID, retryOf, prompt, opts),
	}
	resCh := make(chan Result, 1)
	go func() {
		defer cancel()
		start := time.Now()
		res := r.run()
		res.DurationMs = time.Since(start).Milliseconds()
		close(r.msgCh)
		resCh <- res
		close(resCh)
	}()
	return &Session{
		Messages:         r.msgCh,
		Result:           resCh,
		TerminalObserved: r.terminal.Load,
	}, nil
}

func (b *bbBackend) buildRequest(key, taskID, retryOf, prompt string, opts ExecOptions) bbPutRequest {
	env := b.cfg.Env
	req := bbPutRequest{
		ProtocolVersion: bbProtocolVersion,
		TaskID:          key,
		MulticaTaskID:   taskID,
		RetryOf:         retryOf,
		Prompt:          prompt,
		SystemPrompt:    opts.SystemPrompt,
		ResumeSessionID: opts.ResumeSessionID,
		Model:           opts.Model,
		ChatSessionID:   env[BBEnvChatSessionID],
		Multica: bbMulticaContext{
			ServerURL:   opts.MulticaServerURL,
			WorkspaceID: opts.MulticaWorkspaceID,
			TaskToken:   opts.TaskToken,
		},
	}
	if n, err := strconv.Atoi(env[BBEnvAttempt]); err == nil {
		req.Attempt = n
	}
	if env[BBEnvIssueID] != "" || env[BBEnvIssueIdentifier] != "" {
		req.Issue = &bbIssue{ID: env[BBEnvIssueID], Identifier: env[BBEnvIssueIdentifier]}
	}
	if raw := env[BBEnvRepos]; raw != "" {
		_ = json.Unmarshal([]byte(raw), &req.Repos)
	}
	return req
}

// bbRun is the state of one Execute call.
type bbRun struct {
	ep      bbEndpoint
	tuning  bbTunables
	logger  *slog.Logger
	opts    ExecOptions
	parent  context.Context // the daemon's ctx (no local timeout applied)
	ctx     context.Context // parent + opts.Timeout
	msgCh   chan Message
	request bbPutRequest

	runID     string // canonical bb run id from the PUT response
	sessionID string
	lastID    int64
	lastEvent atomic.Int64 // unix nanos of the last bb event
	terminal  atomic.Bool
	output    strings.Builder
}

func (r *bbRun) emit(m Message) bool {
	// Blocking send: dropping a message would leave a gap in the transcript.
	// The daemon drains continuously; ctx bounds the wait during teardown.
	select {
	case r.msgCh <- m:
		return true
	case <-r.ctx.Done():
		return false
	}
}

func (r *bbRun) touch() { r.lastEvent.Store(time.Now().UnixNano()) }
func (r *bbRun) silent() bool {
	return time.Since(time.Unix(0, r.lastEvent.Load())) > r.tuning.silenceTimeout
}

func (r *bbRun) run() Result {
	put, err := r.submit()
	if err != nil {
		if r.ctx.Err() != nil {
			return r.stopped("")
		}
		return Result{Status: "failed", Error: err.Error()}
	}
	r.runID = put.TaskID
	if r.runID == "" {
		r.runID = r.request.TaskID
	}
	r.sessionID = put.SessionID
	if put.Created {
		r.logger.Info("bb task created", "bb_run_id", r.runID, "session_id", r.sessionID)
	} else {
		r.logger.Info("bb task already exists; reattaching", "bb_run_id", r.runID, "status", put.Status, "retry_of", r.request.RetryOf)
	}
	// Pin the resume pointer as early as possible so a daemon crash mid-run
	// does not lose session continuity for the next turn on this issue.
	r.emit(Message{Type: MessageStatus, Status: "running", SessionID: r.sessionID})

	r.touch()
	delay := r.tuning.reconnectBase
	for {
		res, done := r.stream()
		if done {
			return res
		}
		if r.ctx.Err() != nil {
			return r.stopped(r.runID)
		}
		if r.silent() {
			// Leave the bb run alone: silence most often means a partition
			// between us and bb, not a dead run. "timeout" is retryable in
			// Multica, and the retry reattaches via retryOf.
			return Result{
				Status:    "timeout",
				Error:     fmt.Sprintf("bb backend: no events from bb run %s for %s (no heartbeats); giving up on this attempt", r.runID, r.tuning.silenceTimeout),
				SessionID: r.sessionID,
				Output:    r.output.String(),
			}
		}
		select {
		case <-r.ctx.Done():
			return r.stopped(r.runID)
		case <-time.After(jitter(delay)):
		}
		delay = min(delay*2, r.tuning.reconnectMax)
	}
}

// submit PUTs the task, retrying network errors, 5xx and throttling with
// exponential backoff + jitter.
func (r *bbRun) submit() (bbPutResponse, error) {
	path := bbTaskPath(r.request.TaskID, "")
	attempts := max(r.tuning.putAttempts, 1)
	delay := r.tuning.backoffBase
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		var resp bbPutResponse
		err := bbDo(r.ctx, bbHTTPClient, r.ep, http.MethodPut, path, r.request, &resp)
		if err == nil {
			if resp.ProtocolVersion != 0 && resp.ProtocolVersion != bbProtocolVersion {
				return resp, fmt.Errorf("%w: bb speaks v%d, backend implements v%d", ErrBBProtocolSkew, resp.ProtocolVersion, bbProtocolVersion)
			}
			return resp, nil
		}
		lastErr = err
		var httpErr *bbHTTPError
		if errors.As(err, &httpErr) && httpErr.permanent() {
			return resp, fmt.Errorf("bb backend: bb rejected task %s: %w", r.request.TaskID, err)
		}
		if r.ctx.Err() != nil {
			return resp, r.ctx.Err()
		}
		if attempt == attempts {
			break
		}
		r.logger.Warn("bb PUT failed; retrying", "attempt", attempt, "of", attempts, "error", err)
		r.emit(Message{Type: MessageLog, Level: "warn", Content: fmt.Sprintf("bb unavailable (attempt %d/%d): %v", attempt, attempts, err)})
		select {
		case <-r.ctx.Done():
			return resp, r.ctx.Err()
		case <-time.After(jitter(delay)):
		}
		delay = min(delay*2, r.tuning.backoffMax)
	}
	return bbPutResponse{}, fmt.Errorf("bb backend: could not hand task %s to bb after %d attempts: %w", r.request.TaskID, attempts, lastErr)
}

// jitter returns a duration uniformly distributed in [d/2, d].
func jitter(d time.Duration) time.Duration {
	if d <= 1 {
		return d
	}
	half := d / 2
	return half + time.Duration(rand.Int64N(int64(half)+1))
}

// stream opens one SSE connection and forwards events until the stream ends.
// done=true means a terminal outcome is in res.
func (r *bbRun) stream() (res Result, done bool) {
	connCtx, connCancel := context.WithCancel(r.ctx)
	defer connCancel()

	// Silence watchdog for this connection: a stalled TCP stream produces no
	// error, so cancel the request once bb has been quiet too long.
	watchDone := make(chan struct{})
	defer close(watchDone)
	go func() {
		tick := max(min(r.tuning.silenceTimeout/10, time.Second), time.Millisecond)
		t := time.NewTicker(tick)
		defer t.Stop()
		for {
			select {
			case <-watchDone:
				return
			case <-t.C:
				if r.silent() {
					connCancel()
					return
				}
			}
		}
	}()

	path := bbTaskPath(r.runID, "/events?since="+strconv.FormatInt(r.lastID, 10))
	req, err := http.NewRequestWithContext(connCtx, http.MethodGet, r.ep.base+path, nil)
	if err != nil {
		return Result{Status: "failed", Error: err.Error()}, true
	}
	req.Header.Set("Accept", "text/event-stream")
	if r.lastID > 0 {
		req.Header.Set("Last-Event-ID", strconv.FormatInt(r.lastID, 10))
	}
	if r.ep.token != "" {
		req.Header.Set("Authorization", "Bearer "+r.ep.token)
	}
	resp, err := bbStreamClient.Do(req)
	if err != nil {
		r.logger.Debug("bb events connect failed", "error", err)
		return Result{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		httpErr := &bbHTTPError{Code: resp.StatusCode, Body: strings.TrimSpace(string(body)), Op: "GET " + path}
		if httpErr.permanent() {
			return Result{Status: "failed", Error: httpErr.Error(), SessionID: r.sessionID}, true
		}
		r.logger.Debug("bb events stream refused", "error", httpErr)
		return Result{}, false
	}

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 8<<20)
	var (
		sseID   string
		sseData strings.Builder
	)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			if sseData.Len() == 0 {
				sseID = ""
				continue
			}
			if res, done := r.dispatch(sseID, sseData.String()); done {
				return res, true
			}
			sseID = ""
			sseData.Reset()
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue // SSE comment: transport keepalive, not bb liveness
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "id":
			sseID = value
		case "data":
			if sseData.Len() > 0 {
				sseData.WriteByte('\n')
			}
			sseData.WriteString(value)
		}
	}
	if err := sc.Err(); err != nil && r.ctx.Err() == nil {
		r.logger.Debug("bb events stream broke", "last_id", r.lastID, "error", err)
	}
	return Result{}, false
}

// dispatch handles one SSE event. done=true when it was the terminal result.
func (r *bbRun) dispatch(sseID, data string) (Result, bool) {
	var ev bbEvent
	if err := json.Unmarshal([]byte(data), &ev); err != nil {
		r.logger.Warn("bb sent an undecodable event; ignoring", "error", err)
		return Result{}, false
	}
	if ev.ID == 0 && sseID != "" {
		ev.ID, _ = strconv.ParseInt(sseID, 10, 64)
	}
	if ev.ID <= r.lastID {
		return Result{}, false // replay after reconnect: already forwarded
	}
	if ev.ID != r.lastID+1 {
		// IDs are contiguous per task; a jump means bb lost events. Keep going
		// (the run is still authoritative) but make the gap visible.
		r.logger.Warn("bb event id gap", "expected", r.lastID+1, "got", ev.ID)
	}
	r.lastID = ev.ID
	r.touch()

	switch ev.Kind {
	case "heartbeat":
		// Any message resets the daemon's idle watchdog; a status message with
		// no session id adds nothing to the transcript.
		r.emit(Message{Type: MessageStatus, Status: "running"})
	case "thought":
		r.emit(Message{Type: MessageThinking, Content: ev.Text})
	case "text":
		if ev.Text != "" {
			r.output.WriteString(ev.Text)
			r.emit(Message{Type: MessageText, Content: ev.Text})
		}
	case "tool_call":
		if ev.Phase == "end" {
			r.emit(Message{Type: MessageToolResult, Tool: ev.Tool, CallID: ev.CallID, Output: ev.Output})
		} else {
			r.emit(Message{Type: MessageToolUse, Tool: ev.Tool, CallID: ev.CallID, Input: ev.Input})
		}
	case "error":
		msg := ev.Message
		if msg == "" {
			msg = ev.Error
		}
		r.emit(Message{Type: MessageError, Content: msg})
	case "result":
		r.terminal.Store(true)
		return r.result(ev), true
	default:
		r.logger.Debug("bb ignoring event of unknown kind", "kind", ev.Kind, "id", ev.ID)
	}
	return Result{}, false
}

func (r *bbRun) result(ev bbEvent) Result {
	sessionID := ev.SessionID
	if sessionID == "" {
		sessionID = r.sessionID
	}
	out := ev.Summary
	if out == "" {
		out = r.output.String()
	}
	if ev.PRURL != "" {
		out = strings.TrimSpace(out + "\n\nPull request: " + ev.PRURL)
	}
	switch ev.Status {
	case "succeeded":
		return Result{Status: "completed", Output: out, SessionID: sessionID}
	case "cancelled":
		return Result{Status: "cancelled", Output: out, SessionID: sessionID, Error: "bb run cancelled"}
	default:
		msg := ev.Error
		if msg == "" {
			msg = "bb run failed without an error message"
		}
		return Result{Status: "failed", Output: out, Error: msg, SessionID: sessionID}
	}
}

// stopped decides what a cancelled ctx means (see "shutdown detection").
func (r *bbRun) stopped(runID string) Result {
	if errors.Is(r.ctx.Err(), context.DeadlineExceeded) && r.parent.Err() == nil {
		// MULTICA_AGENT_TIMEOUT is an operator cost cap: stop the bb run too.
		r.cancelRemote(runID)
		return Result{Status: "timeout", Error: fmt.Sprintf("bb task exceeded the agent timeout of %s", r.opts.Timeout), SessionID: r.sessionID}
	}
	if r.shutdownLikely() {
		r.logger.Info("daemon shutting down; leaving bb run running for reattach", "bb_run_id", runID)
		return Result{Status: "aborted", Error: "daemon shut down; bb run left running so the retry can reattach", SessionID: r.sessionID}
	}
	r.cancelRemote(runID)
	return Result{Status: "cancelled", SessionID: r.sessionID}
}

func (r *bbRun) shutdownLikely() bool {
	deadline := time.Now().Add(r.tuning.shutdownGrace)
	for {
		if bbShuttingDownFn() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// cancelRemote POSTs cancel for the run. With no run id yet (still PUTting) we
// cancel by request id: bb treats cancel of an id it has never seen as a
// tombstone, so a PUT that lands late does not start a run.
func (r *bbRun) cancelRemote(runID string) {
	if runID == "" {
		runID = r.request.TaskID
	}
	ctx, cancel := context.WithTimeout(context.Background(), r.tuning.cancelTimeout)
	defer cancel()
	delay := r.tuning.reconnectBase
	for {
		err := bbDo(ctx, bbHTTPClient, r.ep, http.MethodPost, bbTaskPath(runID, "/cancel"), nil, nil)
		if err == nil {
			r.logger.Info("bb run cancelled", "bb_run_id", runID)
			return
		}
		var httpErr *bbHTTPError
		if errors.As(err, &httpErr) && httpErr.permanent() {
			r.logger.Warn("bb refused cancel", "bb_run_id", runID, "error", err)
			return
		}
		select {
		case <-ctx.Done():
			r.logger.Error("could not confirm bb cancel; the bb run may still be active", "bb_run_id", runID, "error", err)
			return
		case <-time.After(jitter(delay)):
		}
		delay = min(delay*2, r.tuning.reconnectMax)
	}
}
