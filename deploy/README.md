# deploy/: everything on Kubernetes

`skaffold dev` brings the whole system up on a local kind cluster:
- stock Multica: the official Helm chart from the `upstream/` submodule, with GHCR images at the pinned tag;
- our daemon with the bb backend;
- bb as a **two-node celld fleet**, with MinIO as its fleet bucket and Postgres as its mailbox;
- the **sandbox gateway** and **agent-sandbox** (controller plus a warm pool): every OpenCode session works in a sandbox of its own, on a clone of the issue's repositories.

```bash
kind create cluster --name bb --config deploy/kind/cluster.yaml
skaffold dev
```

Then open <http://localhost:3000> and sign in as `bb-admin@example.com` with code `888888`. The daemon creates that user, a workspace, its token and a `bb` agent on first start. Assign an issue to **bb** and watch the run stream in.

### Trying the sandbox

Without a model key, bb uses its scripted model. It acknowledges the task, and a line `run: <command>` in the issue makes it run that command through OpenCode's shell tool, in the sandbox. For example, an issue whose description ends with:

```text
run: git -C myrepo log --oneline -3 && echo hi > myrepo/hello.txt
```

The run shows the command, its output, `Changed in the workspace: myrepo/hello.txt` and the result. The change is now in bb's copy on the gateway (`kubectl exec deploy/bb-gateway -- ls /var/lib/bb-gateway/copies`). The issue's repositories come from Multica's workspace repositories; the gateway clones them, so they must be reachable from the cluster (public, for now).

```bash
kubectl --context kind-bb get sandboxwarmpools,sandboxclaims,sandboxes
kubectl --context kind-bb logs deploy/bb-gateway
```

### GitHub: private repositories and pull requests

Give the gateway a GitHub token, and runs that change files push a branch `bb/<conversation>` and open a **draft** pull request (later runs in the same conversation add commits to it). Use a fine-grained personal access token limited to the repositories bb should touch, with **Contents: read and write** and **Pull requests: read and write** (Metadata: read comes with them).

```bash
kubectl --context kind-bb create secret generic bb-github --from-literal=GITHUB_TOKEN=...
kubectl --context kind-bb rollout restart deployment/bb-gateway
```

The token stays in the gateway: the Worker and the sandbox never see it, and it is passed to git per command (never written into a remote URL or `.git/config`). Without a token, public repositories still clone and runs report `Could not publish the changes: …`. `BB_PUBLISH` on bb (`none`, `draft-pr`, `pr`) chooses what happens after a run; kind uses `draft-pr`.

Idle sandboxes are given back after 30 minutes (`BB_SANDBOX_IDLE_MINUTES` on the gateway), after their work is copied to bb's copy; the next run in that conversation claims a new one from it.

### Using Claude

```bash
kubectl --context kind-bb create secret generic bb-model --from-literal=BB_MODEL=claude --from-literal=ANTHROPIC_API_KEY=...
kubectl --context kind-bb rollout restart statefulset/bb
```

`BB_CLAUDE_MODEL` in the same Secret picks another model (default `claude-opus-5-5`). celld has only plain vars, so the key ends up in the fleet bucket: fine on kind, not in production (Bedrock through a signing proxy instead).

| Port-forward | What |
| --- | --- |
| `localhost:3000` | Multica web UI (`multica-frontend`) |
| `localhost:8080` | Multica API (`multica-backend`) |
| `localhost:8787` | bb (`bb` Service). Same port as mock-bb, so the drills run against the cluster too. |

To run the drills against the cluster (with `skaffold dev` running), give them the daemon pod in place of the compose service:

```bash
kubectl exec deploy/multica-bb-daemon -- multica issue create --title "hello" --assignee bb
curl -s localhost:8787/admin/state | jq .
```

## Files

| File | What |
| --- | --- |
| `kind/cluster.yaml` | kind cluster. It includes the kubelet `failCgroupV1: false` patch for older cgroup v1 hosts; cgroup v2 hosts ignore it. |
| `values.yaml`, `values-dev.yaml` | Overrides for the official chart. `values-dev.yaml` turns ingress and persistence off and sets `APP_ENV=development` for the dev sign-in code. |
| `k8s/secrets.dev.yaml` | **Dev only** secrets: the chart's `multica-secrets` and `bb-secrets`. |
| `k8s/minio.yaml` | MinIO plus a sidecar that creates the `bb-fleet` bucket. Fine for kind; not qualified for production. |
| `k8s/bb-postgres.yaml` | bb's mailbox database. |
| `k8s/bb.yaml` | The bb StatefulSet (two celld nodes), its headless peer Service and the `bb` Service. Pod `bb-0` publishes the deployment to the bucket. |
| `k8s/bb-gateway.yaml` | The sandbox gateway (bb's hands: git, tar, the Kubernetes API, sandboxd), its RBAC for SandboxClaims, and a volume for bb's copies of workspaces. |
| `k8s/sandbox.yaml` | agent-sandbox's SandboxTemplate and SandboxWarmPool for bb: `sandbox/Dockerfile` (sandboxd plus git, ripgrep and friends). |
| `k8s/vendor/agent-sandbox-v1.0.9.yaml` | agent-sandbox's release manifest (CRDs and controller), pinned. skaffold's deploy hook applies it first. |
| `k8s/daemon.yaml` | Our daemon. It points at `multica-backend` and `bb`, bootstraps itself with the dev code, and creates the `bb` agent. |

## Production differences

These all come down to replacing the dev shortcuts:
- **Secrets:** create `multica-secrets` and `bb-secrets` out of band, never from `secrets.dev.yaml`. Give the daemon a real `MULTICA_PAT` from a Secret, and drop `MULTICA_DEV_BOOTSTRAP_EMAIL` and `values-dev.yaml`'s `appEnv`.
- **Fleet bucket:** S3, R2 or GCS instead of MinIO. Set `CELLD_BUCKET` and drop `S3_ENDPOINT`.
- **Test mode:** remove `BB_TEST_ADMIN=1` from `k8s/bb.yaml`. It exposes `/admin` and the fault switches.
- **Storage:** give `bb-postgres` and Multica's Postgres real volumes.
- **Network:** keep bb's internal port (8081) on the cluster network only. celld peer traffic is unauthenticated plaintext.
- **Sandboxes:** `networkPolicyManagement: Managed` with an ingress rule for the gateway and tight egress; a sandboxd token (`BB_SANDBOXD_TOKEN`); a released sandboxd image pinned by digest; a RuntimeClass such as gVisor.
- **Model:** Bedrock with the pod's IAM role, through a signing proxy, instead of an API key.
