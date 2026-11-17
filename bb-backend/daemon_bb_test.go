package daemon

// Copied into upstream/server/internal/daemon/ alongside daemon_bb.go. Guards
// every hunk of patches/register-bb.patch so an upstream bump that silently
// drops one fails CI instead of production.

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
	"github.com/multica-ai/multica/server/pkg/agent"
)

func TestBBAgentEntryAdvertisedOnlyWithEndpoint(t *testing.T) {
	t.Setenv("MULTICA_BB_ENDPOINT", "")
	if _, ok := bbAgentEntry(); ok {
		t.Fatal("bb advertised without MULTICA_BB_ENDPOINT")
	}
	t.Setenv("MULTICA_BB_ENDPOINT", "http://bb:8787")
	t.Setenv("MULTICA_BB_MODEL", "bb-default")
	e, ok := bbAgentEntry()
	if !ok || e.Command != "bb" || e.Path != "" || e.Model != "bb-default" {
		t.Fatalf("entry = %+v ok=%v", e, ok)
	}
	if providerDisplayName("bb") != "bb" {
		t.Fatalf("display name = %q", providerDisplayName("bb"))
	}
}

func TestProbeBuiltinRuntimeRoutesBBToHealthProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"protocolVersion":1,"version":"bb-2026.11"}`))
	}))
	defer srv.Close()
	t.Setenv("MULTICA_BB_ENDPOINT", srv.URL)

	d := newTestDaemon(t)
	d.agentVersions = map[string]string{}
	// Empty Path: there is no binary, and the probe must not go looking for one.
	version, reason, verdict := d.probeBuiltinRuntime(context.Background(), "bb", AgentEntry{Command: "bb"})
	if verdict != builtinProbeOK || version != "bb-2026.11" {
		t.Fatalf("verdict=%v version=%q reason=%q", verdict, version, reason)
	}
}

func TestProbeBBUnreachableAndSkew(t *testing.T) {
	d := newTestDaemon(t)
	d.agentVersions = map[string]string{}
	t.Setenv("MULTICA_BB_ENDPOINT", "http://127.0.0.1:1")
	if _, _, v := d.probeBB(context.Background()); v != builtinProbeUnavailable {
		t.Fatalf("unreachable verdict = %v", v)
	}
	skew := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"protocolVersion":9}`))
	}))
	defer skew.Close()
	t.Setenv("MULTICA_BB_ENDPOINT", skew.URL)
	if _, _, v := d.probeBB(context.Background()); v != builtinProbeProtocolSkew {
		t.Fatalf("skew verdict = %v", v)
	}
}

func TestBBTaskDecodesRetryLineage(t *testing.T) {
	var task Task
	if err := json.Unmarshal([]byte(`{"id":"t2","parent_task_id":"t1","attempt":2}`), &task); err != nil {
		t.Fatal(err)
	}
	if task.ParentTaskID != "t1" || task.Attempt != 2 {
		t.Fatalf("task = %+v", task)
	}
}

func TestBBTaskEnvironment(t *testing.T) {
	task := Task{
		ID: "t2", AgentID: "a", WorkspaceID: "w", IssueID: "i", IssueIdentifier: "ENG-1",
		ParentTaskID: "t1", Attempt: 2,
		Repos: []RepoData{{URL: "https://github.com/acme/app", Ref: "main"}},
	}
	env := taskMulticaEnvironment(task, "bb", "bb-agent", "mat_x", "/cfg", "/ws", "http://srv", 0, 0, "/tmp/x")
	want := map[string]string{
		agent.BBEnvIssueID:         "i",
		agent.BBEnvIssueIdentifier: "ENG-1",
		agent.BBEnvParentTaskID:    "t1",
		agent.BBEnvAttempt:         "2",
		agent.BBEnvRepos:           `[{"url":"https://github.com/acme/app","ref":"main"}]`,
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("%s = %q, want %q", k, env[k], v)
		}
	}
	other := taskMulticaEnvironment(task, "claude", "x", "mat_x", "/cfg", "/ws", "http://srv", 0, 0, "/tmp/x")
	if _, ok := other[agent.BBEnvParentTaskID]; ok {
		t.Error("bb metadata leaked into another provider's env")
	}
	if !isBlockedEnvKey(agent.BBEnvParentTaskID) {
		t.Error("custom_env could override bb task metadata")
	}
}

func TestBBResumeSurvivesMissingWorkdir(t *testing.T) {
	// bb's session lives in a remote Durable Object, so an ephemeral daemon pod
	// losing the prior workdir must not drop it.
	task := &Task{PriorSessionID: "do-session", PriorWorkDir: "/gone/elsewhere"}
	taskCtx := &execenv.TaskContextForEnv{}
	if !gateResumeToReachableSession(task, taskCtx, "bb", t.TempDir(), false, false, false, false, slog.Default()) {
		t.Fatal("bb resume gated off")
	}
	if task.PriorSessionID != "do-session" {
		t.Fatalf("prior session cleared: %q", task.PriorSessionID)
	}
}

func TestBBGetsInlineSystemPrompt(t *testing.T) {
	if !providerNeedsInlineSystemPrompt("bb") {
		t.Fatal("bb cannot read the brief from the daemon's disk; it must be inlined")
	}
}
