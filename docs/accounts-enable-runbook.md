# Accounts Enablement Runbook

This is the consolidated, step-by-step runbook for turning on Google-only
accounts in production later. It complements
[docs/accounts-phase1.md](accounts-phase1.md), which documents what the
accounts layer *is*; this doc is the operational checklist for *turning it
on* and, if needed, *turning it back off*.

**Nothing in this document is executed by writing it.** As of this readiness
pack, production remains exactly as before: `AUTH_ENABLED` absent/`false`,
no Postgres running, no OAuth credentials configured, legacy
`ADMIN_PASSWORD` Basic-auth admin login and all SQLite model/QR flows
unchanged.

---

## Current dormant state

- `AUTH_ENABLED` is absent/`false` in production. The accounts router is not
  even mounted; `/login` does not exist; `/admin` is protected by legacy
  Basic auth (`ADMIN_PASSWORD`).
- The additive SQLite ownership columns (`organization_id`,
  `created_by_user_id`, `visibility`) exist on `models` but are inert while
  auth is disabled.
- PostgreSQL is **not** running in production. `deploy/docker-compose.postgres.yml`
  exists but is never included by the default deploy path
  (`scripts/deploy-elitedesk.sh`) unless explicitly requested.
- No Google (or Microsoft) OAuth credentials exist anywhere in this repo or
  on EliteDesk. Registering the OAuth app and issuing credentials is
  intentionally **out of scope** until you decide to enable accounts.
- Public/QR viewer routes (`/public/:token`, `/public/:token/model.json`,
  `/public/:token/model.glb`) and `/health` are unaffected by any of this —
  they do not go through the accounts router at all.

---

## Exact env vars required later

Set these in the EliteDesk `.env` (`/home/claudio/projects/3d-model-web-viewer/.env`)
**only** — never commit them, never paste real values into chat or a PR:

| Variable | Purpose |
|---|---|
| `AUTH_ENABLED=true` | Turns the accounts layer on. Leave unset/`false` until every other step below is done and smoke-tested. |
| `AUTH_PROVIDERS=google` | Google-only for this phase (this is also the default if unset). |
| `APP_BASE_URL` | e.g. `https://modelbase.parametricstandards.com` — must match the registered OAuth redirect URI. |
| `DATABASE_URL` | `postgres://modelbase:<STRONG_PW>@postgres:5432/modelbase` |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | Consumed by `deploy/docker-compose.postgres.yml`. |
| `SESSION_COOKIE_NAME` | Optional, defaults to `modelbase_session`. |
| `SESSION_SECRET` | Long random value (e.g. `openssl rand -base64 48`). Signs the OAuth transaction cookie and session tokens. |
| `SESSION_COOKIE_SECURE=true` | Required in production (HTTPS). The server refuses to start with `AUTH_ENABLED=true` + `NODE_ENV=production` without it (or `ALLOW_INSECURE_SESSION=true` as a deliberate override). |
| `AUTH_ALLOWED_EMAILS` | Comma-separated allow-list of approved admin Google emails. Required and fail-closed — the server refuses to start with `AUTH_ENABLED=true` if empty. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From the Google OAuth app (see [docs/accounts-phase1.md](accounts-phase1.md#1-register-the-oauth-app)). |

None of these should be set in production yet as part of this readiness pack.

---

## How to bring up Postgres later

Postgres lives in a separate, optional compose file
(`deploy/docker-compose.postgres.yml`) so the default deploy path is
untouched until you opt in. It has no published host port (reachable only on
the project's Docker network), a healthcheck, `restart: unless-stopped`, and
reads its credentials from `.env` — nothing is hardcoded or committed.

Two equivalent ways to start it:

```bash
# 1. Via the deploy script's built-in opt-in flag (recommended):
INCLUDE_POSTGRES=true ./scripts/deploy-elitedesk.sh
# or:
./scripts/deploy-elitedesk.sh --with-postgres

# 2. Directly with docker compose:
docker compose \
  -f deploy/docker-compose.elitedesk.yml \
  -f deploy/docker-compose.postgres.yml \
  up -d --build
```

The default deploy command (`./scripts/deploy-elitedesk.sh`, no flag/env var)
continues to bring up **only** `server`+`worker` — its services guard fails
loudly if that's not exactly what would run. This is covered by
`node --test scripts/deploy-elitedesk.test.mjs`, which exercises both the
default and `--with-postgres` paths against a fake `docker`/`git` (no real
Docker daemon or network access required; requires `bash` on `PATH`).

Postgres data persists at `data/postgres` on the host (inside the
git-ignored `data/` directory) via a bind mount — back it up like any other
file under `data/`.

---

## How to run `accounts-preflight.mjs`

Read-only; safe to run against production at any time, with or without
`AUTH_ENABLED` set:

```bash
cd apps/server
node scripts/accounts-preflight.mjs              # env + SQLite readiness
node scripts/accounts-preflight.mjs --check-db   # also test Postgres connectivity
node scripts/accounts-preflight.mjs --json       # machine-readable
```

It never enables auth, runs migrations, writes to any database, or prints
secret values or public-share tokens. Read the overall `status`
(`PASS`/`WARN`/`FAIL`) and the `blockers`/`warnings` lists before proceeding
to the next step. `FAIL` means do not continue; `WARN` is worth reading but
not necessarily blocking.

---

## How to back up SQLite before assignment

Before running the model-assignment script for real, back up **both**
SQLite and Postgres:

```bash
# SQLite (from EliteDesk, with the stack running or stopped):
cp /home/claudio/projects/3d-model-web-viewer/data/db/app.sqlite \
   /home/claudio/projects/3d-model-web-viewer/data/db/app.sqlite.bak-$(date +%Y%m%d-%H%M%S)

# Postgres (logical dump, requires the postgres container running):
docker exec <postgres-container-name> \
  pg_dump -U modelbase modelbase > postgres-modelbase-$(date +%Y%m%d-%H%M%S).sql
```

Keep these backups outside the repo (never commit them — `data/` and any
`.sql`/`.sqlite` dump are excluded by `.gitignore` for this reason).

---

## How to dry-run model assignment

```bash
cd apps/server
DATABASE_URL=postgres://... DATA_DIR=/app/data \
  node scripts/assign-models-to-default-org.mjs --owner-email you@example.com --dry-run
```

Makes **no writes**. Prints: target workspace id/name, total models, how many
are already assigned, how many would be assigned this run, and a list of any
"suspicious" models (soft-deleted-but-unassigned, or missing a slug/name)
worth a manual look before applying.

---

## How to run real model assignment later

Only after reviewing the dry run and taking backups:

```bash
cd apps/server
DATABASE_URL=postgres://... DATA_DIR=/app/data \
  node scripts/assign-models-to-default-org.mjs --owner-email you@example.com \
  --require-backup-confirmation
```

`--require-backup-confirmation` is a deliberate speed bump — the script does
not itself verify a backup exists, it just refuses to write without the
flag. The script is repeatable (only touches `organization_id IS NULL` rows)
and fails loudly if any model remains unassigned afterward.

Rollback for this step alone (without restoring a full backup):

```sql
UPDATE models SET organization_id = NULL, created_by_user_id = NULL
WHERE organization_id = '<org-id-printed-by-the-script>';
```

---

## How to set `AUTH_ENABLED=true` later

1. Confirm `node scripts/accounts-preflight.mjs --check-db` reports overall
   `status: PASS` (no blockers).
2. Set `AUTH_ENABLED=true` in the EliteDesk `.env`.
3. Redeploy with the **default** command (no Postgres flag needed once
   Postgres is already running from a prior step):
   ```bash
   ./scripts/deploy-elitedesk.sh
   ```
4. Watch server logs for a clean startup (no fail-closed errors about
   `AUTH_ALLOWED_EMAILS`, `SESSION_COOKIE_SECURE`, or `AUTH_STORE`).

---

## How to smoke-test Google login later

1. Visit `${APP_BASE_URL}/login` — should show a "Continue with Google"
   button only (Google-only mode).
2. Sign in with an email in `AUTH_ALLOWED_EMAILS`. Confirm redirect to
   `/admin` and that `/api/me` reflects the signed-in user.
3. Sign in (or attempt to) with an email **not** in `AUTH_ALLOWED_EMAILS` —
   confirm it's rejected with `/login?error=email_not_allowed` and that no
   user/identity/workspace row was created for it.
4. Confirm the public/QR flow is still unaffected:
   `/public/:token`, `/public/:token/model.json`,
   `/public/:token/model.glb` all still return 200 without any session.
5. Sign out via the admin UI (POST logout) and confirm `/admin` redirects
   back to `/login`.

---

## How to rollback to `AUTH_ENABLED=false`

Instant, no data migration required:

1. Set `AUTH_ENABLED=false` (or remove the line) in `.env`.
2. Redeploy: `./scripts/deploy-elitedesk.sh`.
3. Confirm `/login` returns 404 again and `/admin` is protected by legacy
   Basic auth.

The accounts router, session resolution, rate limiters, and audit logging
all stop running the moment the flag flips. The additive SQLite ownership
columns and the (separate) Postgres auth tables are inert while disabled —
nothing needs to be reverted in the database. If Postgres was only started
for this rollout and you want to stop it too, that is a separate, explicit
action (`docker compose -f deploy/docker-compose.postgres.yml down`) — not
required for the rollback itself.

---

## What not to do

- Do not set `AUTH_ENABLED=true` in production until every step above has
  been completed and smoke-tested.
- Do not register the Google OAuth app or add real credentials as part of
  this readiness pack — that is a deliberate, separate later step.
- Do not run `assign-models-to-default-org.mjs` for real without a confirmed
  SQLite **and** Postgres backup.
- Do not run production account migrations manually outside these scripts.
- Do not start Postgres in production via any path other than the
  documented opt-in overlay.
- Do not restart Docker globally or reboot EliteDesk to "fix" a stuck
  deploy — diagnose first.
- Do not touch the Raspberry Pi, Cloudflare tunnel config, or the
  Plex/Immich/Homepage/Portainer/Dozzle/Uptime Kuma/backup-SSD systems as
  part of any accounts work.
- Do not commit `.env`, secrets, dumps, or anything under `data/`.
