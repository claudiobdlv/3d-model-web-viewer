# Professional Accounts — Phase 1

Phase 1 adds OIDC sign-in (Google, with Microsoft code present but disabled by
default — see below), PostgreSQL-backed accounts, secure database sessions,
organizations/workspaces, and workspace-scoped admin access — all
**feature-flagged off by default**. With `AUTH_ENABLED=false` (the default),
nothing changes: the legacy `ADMIN_PASSWORD` Basic-auth admin flow and every
existing SQLite model/job/share flow behave exactly as before.

This document is the runbook for turning accounts on later.

## This phase is Google-only

The intended production mode for this phase is **Google sign-in only**, gated
by an admin email allow-list:

- `AUTH_PROVIDERS=google` (the default) excludes Microsoft from `/login` and
  from the `/auth/microsoft/*` routes, even if Microsoft credentials happen to
  be configured. See [Re-enabling Microsoft](#re-enabling-microsoft-later)
  below.
- `AUTH_ALLOWED_EMAILS` is a **required**, comma-separated allow-list of
  verified Google emails. The server refuses to start with
  `AUTH_ENABLED=true` if it is empty — there is no way to accidentally enable
  accounts with open self-serve signup. See
  [Restricting admin access](#restricting-admin-access-to-approved-google-emails).
- Basic auth (`ADMIN_PASSWORD`) is **only** the legacy disabled-mode
  (`AUTH_ENABLED=false`) fallback. Once `AUTH_ENABLED=true`, `/admin` and every
  other admin route require a session cookie minted via Google OIDC — a valid
  `Authorization: Basic ...` header is no longer consulted at all. Basic-auth
  code is kept (not deleted) so flipping `AUTH_ENABLED` back to `false` is an
  instant rollback while accounts are still being rolled out.

---

## What was built in this phase

| Area | Where |
|---|---|
| Domain types | `apps/server/src/auth/types.ts` |
| Feature-flag + provider config | `apps/server/src/auth/config.ts` |
| Session/PKCE tokens (hashing, HMAC) | `apps/server/src/auth/tokens.ts` |
| OIDC (PKCE, discovery, JWKS verify, **pure** claim validation) | `apps/server/src/auth/oidc.ts` |
| Persistence interface | `apps/server/src/auth/store.ts` |
| PostgreSQL store + migration runner | `apps/server/src/auth/pgStore.ts` |
| In-memory store (tests / no-DB dev) | `apps/server/src/auth/memoryStore.ts` |
| SQL schema | `apps/server/src/auth/migrations/0001_auth_init.sql` |
| Login / collision / session service | `apps/server/src/auth/service.ts` |
| Authorization middleware | `apps/server/src/auth/middleware.ts` |
| Routes (login page, OAuth, logout, `/api/me`) | `apps/server/src/auth/routes.ts` |
| Wiring + flag-aware admin guard | `apps/server/src/auth/index.ts`, `apps/server/src/server.ts` |
| SQLite ownership columns | `apps/server/src/db.ts` (`organization_id`, `created_by_user_id`, `visibility`) |
| Optional Postgres service | `deploy/docker-compose.postgres.yml` |
| Data assignment script | `apps/server/scripts/assign-models-to-default-org.mjs` |

### Database split (this phase)

- **PostgreSQL** is the canonical store for the **auth/account layer only**:
  `users`, `auth_identities`, `sessions`, `organizations`,
  `organization_memberships`, `audit_events`.
- **SQLite** keeps owning `models`, `jobs`, `model_revisions`, `public_shares`
  (unchanged). Models gained three ownership columns so the SQLite layer can be
  scoped by workspace. A full models→Postgres migration is a **later phase**.

---

## Security model

- **Sessions** are opaque 256-bit random tokens (`base64url`, 43 chars). Only the
  SHA-256 **hash** is stored in `sessions.token_hash`; the raw token lives only in
  the `modelbase_session` cookie.
- **Cookie flags:** `HttpOnly`, `SameSite=Lax` (configurable), `Path=/`, and
  `Secure` automatically in production (`NODE_ENV=production`).
- **OAuth:** Authorization Code Flow **with PKCE (S256)**. The callback validates
  `state`, `nonce`, issuer, audience (client id), expiry, subject, and rejects
  explicitly-unverified emails. ID token signatures are verified against the
  provider JWKS (`jose`). The transaction cookie carrying state/nonce/verifier is
  HMAC-signed with `SESSION_SECRET`.
- **Account-collision rule:** a brand-new provider identity for an email that
  already belongs to another account is **never auto-merged** — the user is told
  to sign in with their original method. (Account linking = Phase 2.)
- **Workspace scoping:** when accounts are on, the admin model list, model detail,
  and file/download routes are scoped to the caller's active organization; a
  cross-workspace slug/ID returns 404.
- **Worker auth is session-independent:** worker job routes authenticate with
  `Authorization: Bearer <WORKER_API_TOKEN>` (this is the Phase 1 "worker
  secret"), never cookies. Unchanged by this work.
- **Logging:** raw OAuth/session/share tokens and client secrets are never
  logged; audit events store only sanitized user/org ids + event metadata.

---

## Enabling accounts later (runbook)

### Google-only setup checklist

1. **Google OAuth app** — register it (steps below) and get a client ID/secret.
2. **Callback URL** — registered redirect URI must exactly match
   `${APP_BASE_URL}/auth/google/callback`.
3. `GOOGLE_CLIENT_ID` — from the Google OAuth app.
4. `GOOGLE_CLIENT_SECRET` — from the Google OAuth app.
5. `AUTH_ALLOWED_EMAILS` — comma-separated allow-list of approved admin Google
   emails. Required; the server fails to start with `AUTH_ENABLED=true` if
   this is empty.
6. `AUTH_ENABLED=true` — only after the above are configured and smoke-tested.
7. `SESSION_COOKIE_SECURE=true` — required in production (HTTPS).
8. `DATABASE_URL` — PostgreSQL connection string for the auth/account layer.
9. `SESSION_SECRET` — long random value, signs the OAuth transaction cookie.

`AUTH_PROVIDERS` defaults to `google` — leave it unset/`google` for this phase.
Microsoft env vars (`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`,
`MICROSOFT_TENANT`) are **optional/future** — not required for this phase; see
[Re-enabling Microsoft](#re-enabling-microsoft-later) if you need them later.

**Secrets must be placed directly in the EliteDesk `.env` file, never
committed to git and never pasted into chat.**

### 1. Register the OAuth app

**Google** — <https://console.cloud.google.com/apis/credentials>
1. Create an *OAuth client ID* → *Web application*.
2. Authorized redirect URIs:
   - Production: `https://modelbase.parametricstandards.com/auth/google/callback`
   - Local: `http://localhost:3009/auth/google/callback`
3. Copy the client ID/secret → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

> Redirect URIs are derived from `APP_BASE_URL` as `${APP_BASE_URL}/auth/<provider>/callback`.
> Whatever you register MUST match `APP_BASE_URL`.

### 2. Configure secrets on EliteDesk

Add to `/home/claudio/projects/3d-model-web-viewer/.env` (never commit it,
never paste real values into chat):

```
AUTH_ENABLED=true
AUTH_PROVIDERS=google
APP_BASE_URL=https://modelbase.parametricstandards.com
DATABASE_URL=postgres://modelbase:<STRONG_PW>@postgres:5432/modelbase
POSTGRES_DB=modelbase
POSTGRES_USER=modelbase
POSTGRES_PASSWORD=<STRONG_PW>
SESSION_COOKIE_NAME=modelbase_session
SESSION_SECRET=<LONG_RANDOM>
SESSION_COOKIE_SECURE=true
AUTH_ALLOWED_EMAILS=claudio@example.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

### 3. Bring up PostgreSQL (private to the Docker network)

The Postgres service lives in a **separate** compose file so the current deploy
path is untouched until you opt in:

```
docker compose \
  -f deploy/docker-compose.elitedesk.yml \
  -f deploy/docker-compose.postgres.yml \
  up -d --build
```

Then update the service-name guard in `scripts/deploy-elitedesk.sh` to allow
`postgres` (currently it asserts exactly `server`+`worker`).

Migrations run automatically on server startup when `AUTH_ENABLED=true`
(`schema_migrations` tracks applied files; re-runs are no-ops).

### 4. Assign existing models to a default workspace

1. Sign in once as the owner (creates the user + "Personal Workspace").
2. Back up the SQLite DB and Postgres.
3. Run (from `apps/server`):

```
DATABASE_URL=postgres://... DATA_DIR=/app/data \
  node scripts/assign-models-to-default-org.mjs --owner-email you@example.com --dry-run
# review, then drop --dry-run
```

The script is repeatable and fails loudly if any model remains unassigned.

---

## Restricting admin access to approved Google emails

`AUTH_ALLOWED_EMAILS` is a comma-separated allow-list of verified Google
emails, e.g. `AUTH_ALLOWED_EMAILS=claudio@example.com,another@example.com`.
Enforced in `apps/server/src/auth/service.ts` (`AuthService.loginWithProvider`):

- Required whenever `AUTH_ENABLED=true` — `apps/server/src/auth/index.ts`
  throws at startup if the list is empty (fail closed: no unapproved Google
  account can self-provision the first admin workspace).
- Checked on **every** login attempt, not just first-time signup, so removing
  an email from the list revokes access immediately — including for a
  previously-approved returning user.
- Emails are normalized to lowercase and trimmed before comparison.
- An unapproved email is rejected with a clear `/login?error=email_not_allowed`
  message; **no user, identity, or workspace row is created** for the
  rejected attempt.
- Identity is still keyed on `(provider, issuer, subject)`, never on email
  alone, once an account exists — the allow-list is an additional gate at
  sign-in, not a replacement for identity matching.

## Re-enabling Microsoft later

Microsoft's OIDC code (`apps/server/src/auth/oidc.ts`, the
`/auth/microsoft/start` and `/auth/microsoft/callback` routes, and the
`auth_identities.provider` schema) is kept in the codebase for future reuse —
it is simply excluded by the default provider allow-list. To turn it back on:

1. Set `AUTH_PROVIDERS=google,microsoft` (or just `microsoft` to disable
   Google instead).
2. Register the Microsoft OAuth app (Entra) and configure
   `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT` — see
   the Microsoft registration steps that shipped with the original Phase 1
   work (App registrations → redirect URI
   `${APP_BASE_URL}/auth/microsoft/callback`, tenant `common` for both
   personal and work/school accounts).
3. The `/login` page will then show both "Continue with Google" and "Continue
   with Microsoft" automatically (`apps/server/src/auth/routes.ts` derives the
   buttons from `config.providers`, which is itself derived from
   `AUTH_PROVIDERS` + whichever credentials are set).

No code changes are required to re-enable Microsoft — only configuration.

---

## Local development without real OAuth

You can exercise the session/guard machinery without Postgres or a provider:

```
AUTH_ENABLED=true AUTH_STORE=memory SESSION_SECRET=dev AUTH_ALLOWED_EMAILS=you@example.com npm run dev
```

`/login` renders (Google button only, by default; no provider buttons unless
client creds are set), `/admin` and `/api/*` require a session, and `/api/me`
reports the current session. This is the mode the automated HTTP tests use.

---

## Tenant-safety hardening (post security review)

A security review found that while `AUTH_ENABLED=false` was production-safe,
`AUTH_ENABLED=true` was not yet tenant-safe. The following hardening makes the
enabled mode safe; the disabled (legacy SQLite + Basic-auth) path is unchanged.

**Central authorization layer.** `auth/access.ts` holds the only place tenant
decisions are made: `authorizeRole`, `authorizeModelAccess`, and
`authorizeUploadHandle`. Mode is keyed off the explicit `req.authEnabled` flag
(set once in `server.ts`), never the mere presence of `req.auth`, so a logged-out
request on an auth-enabled server fails closed instead of falling through to
legacy behaviour. When disabled, every helper is a pure pass-through.

**Role matrix.** `viewer` = read only (view private models + display GLB).
`member` = upload models/revisions and download source files. `admin`/`owner` =
rename, move, trash/restore/delete, manage shares, change default view / revision
settings. Cross-workspace models always 404 (existence is never leaked); an
in-workspace model beyond the caller's role is 403.

**Routes covered.** All `/api/models` mutations + batch, all share
create/read/update/revoke (`/api/models/:id/share`), every artifact route
(`/model-files`, `/downloads/:slug/original|display.glb`, `/admin/logs/...`, the
material/XCAF/mesh report endpoints) with **no filesystem fallback** when the
model row is absent/deleted, and the chunked-upload lifecycle
(init/chunk/complete/cancel) bound to the owning user + organization.

**Folders / projects / jobs / storage quota.** These tables have no organization
column in the Phase 1 schema. Rather than leak cross-workspace data they are
**denied (403) while accounts are enabled** (`workspaceUnavailable` guard +
`projectsUnavailable` checks on model→project association). With accounts
disabled they keep their existing global behaviour. Making them multi-tenant is
deferred to a later phase.

**Deployment safety.** When `AUTH_ENABLED=true` and `NODE_ENV=production`, the
server fails to start unless `SESSION_COOKIE_SECURE=true` (a deliberate
`ALLOW_INSECURE_SESSION=true` override exists for non-HTTPS local/staging only),
and `AUTH_STORE=memory` is rejected outright. Secure-cookie config is now
explicit and no longer relies solely on `NODE_ENV`. The server also fails to
start whenever `AUTH_ENABLED=true` with an empty `AUTH_ALLOWED_EMAILS` — see
[Restricting admin access](#restricting-admin-access-to-approved-google-emails).

**OIDC.** Google logins now require a positively-verified email
(`requireVerifiedEmail`); Microsoft stays lenient because some account types omit
the claim (documented exception — only explicitly-unverified emails are rejected
there). The discovery document's `issuer` is validated against the configured
issuer before use (`validateDiscoveryIssuer`), accepting the Microsoft
multi-tenant `{tenantid}` template.

### Known limitations / deferred (not blockers for continuing the branch)

- **Logout CSRF.** ✅ Resolved in Hardening Pack 1 — logout is now strict
  POST-only. See [Accounts Hardening Pack 1](#accounts-hardening-pack-1).
- **Transactional account provisioning.** ✅ Resolved in Hardening Pack 1 — new
  account provisioning is now atomic on PostgreSQL. See
  [Accounts Hardening Pack 1](#accounts-hardening-pack-1).
- **Multer** upgraded to `^2.2.0`, clearing the high-severity DoS advisory
  (`npm audit --omit=dev` → 0 vulnerabilities).

---

## Accounts Hardening Pack 1

A follow-up hardening pass on top of the tenant-safety work. Everything here is
still **feature-flagged off** (`AUTH_ENABLED=false`): with accounts disabled the
accounts router is not even mounted, so none of the changes below run in
production today. No OAuth credentials, Postgres, or `AUTH_ENABLED=true` are
required to ship it.

### Transactional account provisioning

First-time sign-in provisions a user, their auth identity, a "Personal
Workspace" organization, an owner membership, and the initial audit events
(`user.created`, `organization.created`, `login.success`). These now **commit or
roll back as a single unit**:

- `AuthStore.transaction(fn)` wraps the work. `PgAuthStore.transaction` runs it
  on one dedicated client inside `BEGIN`/`COMMIT`/`ROLLBACK`
  (`apps/server/src/auth/pgStore.ts`). Every statement of a transaction uses
  that client, so a failure anywhere (e.g. the membership insert) rolls back the
  user/identity/organization created earlier — no orphaned half-accounts.
- `MemoryAuthStore.transaction` snapshots and restores its collections, and
  serializes transactions, so tests get real all-or-nothing semantics (and
  deterministic concurrency) without a database
  (`apps/server/src/auth/memoryStore.ts`). The in-memory store also now enforces
  the one-account-per-email rule, mirroring the Postgres
  `users_primary_email_key` unique index.
- A lost concurrency race (a second simultaneous signup for the same
  email/identity) is detected after rollback and re-resolved as a returning
  login or a provider collision, instead of surfacing a raw constraint error
  (`apps/server/src/auth/service.ts`).
- Tests: `apps/server/src/auth/provisioning.test.ts` covers the happy path,
  partial-failure rollback (no orphaned rows), and concurrent-signup
  convergence.

### Strict POST-only logout

- `POST /auth/logout` revokes the session, clears the cookie, and redirects to
  `/login`. This is the only way to sign out, and it is exactly what the admin
  UI uses (`apps/web/src/api.ts` `postLogout`).
- `GET /auth/logout` **no longer logs anyone out.** It returns `405 Method Not
  Allowed` with `Allow: POST` and an informational page; it does **not** revoke
  the session or clear the cookie. This closes the logout-CSRF vector (a
  cross-site `<img>`/link can no longer force-terminate a victim's session) while
  still landing an old bookmarked GET link somewhere sensible.
- Tests: `apps/server/src/auth/adminHttp.test.ts` asserts GET returns 405 and
  leaves the session valid, and that a subsequent POST revokes it.

### Auth-endpoint rate limiting

Lightweight, dependency-free, in-memory (per-process) rate limiting applied
**only** to the accounts router (`apps/server/src/auth/rateLimit.ts`):

- Covered: `GET /auth/:provider/start`, `GET /auth/:provider/callback` (one
  OAuth limiter), and `GET /login` (a separate, higher limiter). Repeated failed
  sign-ins — including `email_not_allowed` denials, which happen inside the
  callback — are blunted because they pass through the rate-limited callback
  endpoint.
- **Not** covered (by design): the public QR/model viewer routes
  (`/public/:token...`) and converter upload routes. The accounts router that
  hosts these limiters is mounted only when `AUTH_ENABLED=true`, so public
  routes can never be affected.
- Keyed by client IP (first `X-Forwarded-For` hop, else socket address). On
  limit it returns `429` with a `Retry-After` header and `Cache-Control:
  no-store`, short-circuiting before any OAuth/discovery work.
- Defaults: 20 OAuth hits / 10 min and 60 `/login` hits / 10 min per IP.
  Tunable via `AUTH_RATE_LIMIT_WINDOW_MS`, `AUTH_RATE_LIMIT_MAX`,
  `AUTH_RATE_LIMIT_LOGIN_MAX` (used by tests to force the limit quickly).
- Tests: `apps/server/src/auth/rateLimit.test.ts` (unit) and
  `apps/server/src/auth/rateLimitHttp.test.ts` (429 triggers on a limited route,
  `/login` is unaffected).

### Audit events

The audit trail (PostgreSQL `audit_events`, in-memory list for tests) records:

| Event | When |
|---|---|
| `login.success` | A user signs in (returning or first-time). |
| `login.rejected` | Login denied — e.g. `email_not_allowed`, `user_disabled`. |
| `login.collision` | Email already owned by a different provider identity. |
| `user.created` / `organization.created` | First-time provisioning (in the tx). |
| `session.created` | A session is minted. |
| `session.revoked` | Logout (`reason: "logout"`) or revocation. |
| `auth.provider_unavailable` | A sign-in was attempted against a provider in the allow-list but without configured credentials (e.g. Microsoft while Google-only). |

Metadata stores only sanitized ids + small flags. Raw session/OAuth tokens,
client secrets, ID tokens, and cookies are **never** logged. Tests:
`apps/server/src/auth/audit.test.ts` (includes an assertion that no audit
metadata contains tokens/secrets/cookies).

### Production enablement preflight script

`apps/server/scripts/accounts-preflight.mjs` is a **read-only** readiness check.
It never enables auth, runs migrations, writes to any database, or prints secret
values (only whether a variable is set). Safe to run against production.

```bash
cd apps/server
node scripts/accounts-preflight.mjs              # env + SQLite readiness
node scripts/accounts-preflight.mjs --check-db   # also test Postgres connectivity (read-only)
node scripts/accounts-preflight.mjs --json        # machine-readable
```

It reports: `AUTH_ENABLED`, `AUTH_PROVIDERS`, `SESSION_COOKIE_SECURE`, presence
(not values) of `AUTH_ALLOWED_EMAILS` (with entry count), `APP_BASE_URL`,
`SESSION_SECRET`, `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; the
count of SQLite models missing `organization_id` plus a dry-run assignment
status; the active public-share count; and, with `--check-db`, whether the
Postgres `schema_migrations` table exists (without applying anything). Exit code
is `0` for a completed check (including "NOT READY") and non-zero only when
`--check-db` connectivity fails.

### Remaining steps before enabling Google login

The hardening pack changes **no** enablement prerequisites. To turn Google login
on later (see the [runbook](#enabling-accounts-later-runbook) for full detail):

1. Register the Google OAuth app; set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
   in the EliteDesk `.env` (never committed).
2. Set `AUTH_ALLOWED_EMAILS` (required fail-closed admin allow-list),
   `SESSION_SECRET`, `APP_BASE_URL`, `SESSION_COOKIE_SECURE=true`, and
   `DATABASE_URL`.
3. Bring up the Postgres compose overlay; let migrations run on startup.
4. Run `node scripts/accounts-preflight.mjs --check-db` and confirm **READY**.
5. Sign in once as the owner, back up SQLite + Postgres, then run
   `assign-models-to-default-org.mjs` (dry-run first) to stamp existing models.
6. Set `AUTH_ENABLED=true` and redeploy.

### Rollback notes

- **Instant rollback:** set `AUTH_ENABLED=false` (or unset it) and redeploy. The
  accounts router, session resolution, rate limiters, and audit logging all stop
  running; the legacy `ADMIN_PASSWORD` Basic-auth flow and SQLite model flows
  resume unchanged. No schema rollback is needed — the additive SQLite ownership
  columns and the (separate) Postgres auth tables are inert while disabled.
- **Rate limiting / logout / audit** are all internal to the accounts router, so
  there is nothing extra to undo beyond flipping the flag.
- **Provisioning transaction:** purely an internal change to how the same rows
  are written; reverting the flag stops all writes. No data migration is implied
  by enabling or disabling it.

---

## Validation status (this session)

**Ran and passing:** `apps/server` typecheck + build, full `apps/server` test
suite (48 tests incl. 29 new auth tests), `apps/worker` typecheck + build,
`apps/converter` smoke test. Both compose files parse as valid YAML.

**Automated coverage includes:** session token + hashing, PKCE S256 derivation,
HMAC transaction-cookie signing/tamper rejection, the full OIDC claim-validation
matrix (issuer/audience/expiry/nonce/subject/email-verification, Microsoft
`common` tenant issuer), account-collision rule, workspace provisioning,
session create/resolve/expiry/revocation, role hierarchy, workspace scoping, and
an end-to-end HTTP test (unauthenticated `/admin`→`/login`, `/api/*`→401, owner
upload stamps `organization_id`/`created_by_user_id`/`visibility=private`,
cross-workspace 404, logout revokes the session).

**Could NOT be tested this session (no OAuth credentials):** the live
Google/Microsoft round trip — real discovery, code exchange, and JWKS signature
verification. The claim-validation logic these depend on is unit-tested in
isolation, but no real end-to-end Google/Microsoft login was performed.

**Not done here (by scope):** `docker compose config` (Docker not installed on the
dev machine — YAML validated instead); the React admin account-menu UI (backend
`/api/me` is provided; the server-rendered `/login` page is implemented); the
models→Postgres migration (deferred to a later phase).
