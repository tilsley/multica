package daemon

// This file is NOT part of upstream Multica. scripts/apply-overlay.sh copies it
// into upstream/server/internal/daemon/ so patches/register-bb.patch only has to
// add one-line calls into it, keeping the patch small and cheap to rebase.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/pkg/agent"
)

func init() {
	// providerDisplayName would title-case the key to "Bb".
	runtimeDisplayNameOverrides["bb"] = "bb"
}

// bbAgentEntry advertises the bb runtime. bb is a remote HTTP service, so there
// is no binary to discover on PATH: the runtime exists exactly when
// MULTICA_BB_ENDPOINT is configured, and reachability is verified by probeBB.
func bbAgentEntry() (AgentEntry, bool) {
	if strings.TrimSpace(os.Getenv("MULTICA_BB_ENDPOINT")) == "" {
		return AgentEntry{}, false
	}
	return AgentEntry{Command: "bb", Model: strings.TrimSpace(os.Getenv("MULTICA_BB_MODEL"))}, true
}

// probeBB is bb's equivalent of CLI version detection: GET /health. An
// unreachable bb is transient (stay unregistered, retry next round); a protocol
// mismatch is deterministic and demotes the runtime.
func (d *Daemon) probeBB(ctx context.Context) (string, string, builtinProbeVerdict) {
	endpoint := strings.TrimSpace(os.Getenv("MULTICA_BB_ENDPOINT"))
	if endpoint == "" {
		return "", "MULTICA_BB_ENDPOINT is not set", builtinProbeUnavailable
	}
	version, err := agent.ProbeBB(ctx, endpoint, strings.TrimSpace(os.Getenv("MULTICA_BB_TOKEN")))
	if err != nil {
		d.logger.Warn("skip registering runtime: bb probe failed", "error", err)
		if errors.Is(err, agent.ErrBBProtocolSkew) {
			return "", err.Error(), builtinProbeProtocolSkew
		}
		return "", err.Error(), builtinProbeUnavailable
	}
	d.setAgentVersion("bb", version)
	return version, "", builtinProbeOK
}

// bbTaskEnvironment adds the task metadata the bb backend forwards to bb. The
// backend has no other route to it: ExecOptions carries no issue, repo or retry
// lineage. MULTICA_* keys cannot be overridden by an agent's custom_env
// (isBlockedEnvKey), so the backend can trust them.
func bbTaskEnvironment(env map[string]string, task Task) {
	set := func(k, v string) {
		if v != "" {
			env[k] = v
		}
	}
	set(agent.BBEnvIssueID, task.IssueID)
	set(agent.BBEnvIssueIdentifier, task.IssueIdentifier)
	set(agent.BBEnvChatSessionID, task.ChatSessionID)
	set(agent.BBEnvParentTaskID, task.ParentTaskID)
	if task.Attempt > 0 {
		env[agent.BBEnvAttempt] = strconv.Itoa(int(task.Attempt))
	}
	if len(task.Repos) > 0 {
		if raw, err := json.Marshal(task.Repos); err == nil {
			env[agent.BBEnvRepos] = string(raw)
		}
	}
}
