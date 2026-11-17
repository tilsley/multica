# deploy/ (phase 3, not exercised yet)

- `values.yaml`: overrides for the **official** chart in `upstream/deploy/helm/multica`. Server, web and Postgres stay stock.
- `daemon.yaml`: our bb daemon Deployment, pointing at the chart's `multica-backend` Service.

```bash
kubectl create ns bb-test
kubectl -n bb-test create secret generic multica-secrets --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 16)" --from-literal=RESEND_API_KEY= \
  --from-literal=GOOGLE_CLIENT_SECRET= --from-literal=CLOUDFRONT_PRIVATE_KEY= --from-literal=MULTICA_DEV_VERIFICATION_CODE=
helm install multica ../upstream/deploy/helm/multica -n bb-test -f values.yaml
# sign in, create a PAT in Settings, then:
kubectl -n bb-test create secret generic multica-bb-daemon --from-literal=MULTICA_PAT=mul_... --from-literal=MULTICA_BB_TOKEN=...
kubectl -n bb-test apply -f daemon.yaml
```
