# deploy/: everything on Kubernetes

`skaffold dev` brings the whole system up on a local kind cluster:
- stock Multica: the official Helm chart from the `upstream/` submodule, with GHCR images at the pinned tag;
- our daemon with the bb backend;
- bb as a **two-node celld fleet**, with MinIO as its fleet bucket and Postgres as its mailbox.

```bash
kind create cluster --name bb --config deploy/kind/cluster.yaml
skaffold dev
```

Then open <http://localhost:3000> and sign in as `bb-admin@example.com` with code `888888`. The daemon creates that user, a workspace, its token and a `bb` agent on first start. Assign an issue to **bb** and watch the run stream in.

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
| `k8s/daemon.yaml` | Our daemon. It points at `multica-backend` and `bb`, bootstraps itself with the dev code, and creates the `bb` agent. |

## Production differences

These all come down to replacing the dev shortcuts:
- **Secrets:** create `multica-secrets` and `bb-secrets` out of band, never from `secrets.dev.yaml`. Give the daemon a real `MULTICA_PAT` from a Secret, and drop `MULTICA_DEV_BOOTSTRAP_EMAIL` and `values-dev.yaml`'s `appEnv`.
- **Fleet bucket:** S3, R2 or GCS instead of MinIO. Set `CELLD_BUCKET` and drop `S3_ENDPOINT`.
- **Test mode:** remove `BB_TEST_ADMIN=1` from `k8s/bb.yaml`. It exposes `/admin` and the fault switches.
- **Storage:** give `bb-postgres` and Multica's Postgres real volumes.
- **Network:** keep bb's internal port (8081) on the cluster network only. celld peer traffic is unauthenticated plaintext.
