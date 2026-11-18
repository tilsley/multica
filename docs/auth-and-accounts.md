# Sign-in and accounts (deferred decisions)

Status: **not decided yet**. The dev setup uses a test-only shortcut. This page records what Multica v0.10.0 supports and what production needs, so the decision is quick when we pick it up. Facts were checked against the pinned upstream source.

## How the dev/kind setup creates accounts (test only)

- **Server setting:** `APP_ENV=development` plus `MULTICA_DEV_VERIFICATION_CODE=888888` (`deploy/values-dev.yaml`, `deploy/k8s/secrets.dev.yaml`). The server accepts that fixed code instead of emailing one, and **ignores it when `APP_ENV=production`**.
- **Daemon bootstrap:** on first start, the daemon's entrypoint (`docker/daemon-entrypoint.sh`, `MULTICA_DEV_BOOTSTRAP_EMAIL`) signs in as `bb-admin@example.com` with that code, which creates the user. It then creates a workspace and a personal access token (PAT), logs in with the PAT, and (`MULTICA_ENSURE_AGENT=bb`) creates the `bb` agent once the bb runtime is online.

None of this belongs in production.

## Server vs daemon

- **Server (one):** the Multica backend, web UI and Postgres. It holds the board, users and sign-in, and the task queue.
- **Daemons (many):** workers that register runtimes and run tasks. Ours runs in the cluster and forwards tasks to bb. The bb agent is workspace-visible, so everyone can assign it work from the web UI or the desktop app. A teammate's desktop app can also run a daemon for their *local* agents (Claude Code, Codex), but nobody needs that for bb.

## Sign-in options in v0.10.0

| Option | Supported | Notes |
|---|---|---|
| Sign in with Google (Google Workspace) | ✅ | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI`. Chart: `backend.config.googleClientId`, `googleRedirectUri`, secret `GOOGLE_CLIENT_SECRET`. |
| Email code | ✅ | Needs an email provider (SMTP or Resend) to deliver codes. |
| Restrict to the company domain | ✅ | `ALLOWED_EMAIL_DOMAINS`, `ALLOWED_EMAILS`, `ALLOW_SIGNUP` |
| Control who creates workspaces | ✅ | `DISABLE_WORKSPACE_CREATION`, `WORKSPACE_CREATION_ALLOWED_EMAILS` |
| Session length | ✅ | 30 days by default, renewed by clients; `AUTH_TOKEN_TTL` |
| SAML / generic OIDC (Okta, Entra ID) | ❌ | Not in v0.10.0 |
| Trust an auth proxy's identity header (IAP, oauth2-proxy) | ❌ | Multica always issues its own session |
| SCIM / admin-created users | ❌ | Users are created on their own first sign-in |
| Google-only login (switch off email codes) | ? | Unverified. Check before relying on it. |

**Closest we get to "no sign-in":** Google sign-in plus `ALLOWED_EMAIL_DOMAINS`. A person clicks once on their first visit (they're already signed in to Workspace, so there's no password), then the session lasts 30+ days. Google IAP in front can additionally keep the server private to Workspace users, but people still click the Multica button once.

## Accounts and membership as code

- **Accounts:** they can't be created as code. Each person is created on their first sign-in.
- **Workspace membership:** it can be managed as code. `POST /api/workspaces/{id}/members` creates an invitation (with an admin's token), and the invitee accepts on first sign-in. A member list in the repo plus a small sync job keeps it declarative.
- **The daemon's identity:** this one is infrastructure. Create a service user once, issue it a PAT, store the PAT in a Secret, and set `MULTICA_PAT` on the daemon instead of `MULTICA_DEV_BOOTSTRAP_EMAIL`.

## Production checklist (when we decide)

1. `APP_ENV=production`; remove `MULTICA_DEV_VERIFICATION_CODE` and the daemon's dev bootstrap.
2. Pick a sign-in method: Google (recommended if we're on Workspace) and/or an email provider.
3. Set `ALLOWED_EMAIL_DOMAINS` to our domain and decide who can create workspaces.
4. Give the daemon a service user and PAT via a Secret.
5. Optional: Google IAP in front; a member-sync job for workspace membership.

## Open questions

- Can email-code login be switched off so Google is the only way in?
- Is one click on first visit acceptable, or do we need proxy-header trust (an upstream feature request)?
- Do we need a non-Google IdP? If so, SAML/OIDC is an upstream gap.
