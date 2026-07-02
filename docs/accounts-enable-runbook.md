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

## How to run the auth DB migrations explicitly (rehearsal)

The server only runs the Postgres auth migrations at startup when
`AUTH_ENABLED=true`. To rehearse (or pre-stage) the migrations **without**
enabling accounts and **without** starting the web app, use the explicit
runner:

```bash
cd apps/server
# List the migrations that would run, open no connection (safe anywhere):
DATABASE_URL=postgres://... node scripts/accounts-migrate-auth-db.mjs --dry-run

# Apply them (requires Postgres reachable on DATABASE_URL):
DATABASE_URL=postgres://... node scripts/accounts-migrate-auth-db.mjs
```

It reads the same `src/auth/migrations/*.sql` files the server applies, wraps
each in its own transaction, and records them in `schema_migrations` so it is
**idempotent** (re-running applies nothing). It does not read or set
`AUTH_ENABLED`, does not start the HTTP server, does not touch the SQLite
models database, and prints only migration file names and counts — never
`DATABASE_URL` or any secret. Behaviour is covered by
`scripts/accounts-migrate-auth-db.test.mjs` and
`scripts/lib/authMigrations.test.mjs` (the latter exercises the apply/rollback
logic against a fake pool, so no real Postgres is needed for tests).

This is the recommended way to satisfy the model-assignment prerequisite
"auth migrations have been applied" without flipping `AUTH_ENABLED`.

---

## How to back up SQLite before assignment

Before running the model-assignment script for real, back up **both**
SQLite and Postgres.

The app database runs in **WAL mode** (`PRAGMA journal_mode = WAL`), so a plain
`cp app.sqlite` while the server is live can capture a torn/partial state (the
most recent pages may still be in `app.sqlite-wal`). Use `VACUUM INTO`, which
takes a read-consistent snapshot even with the server writing — this is the
**recommended one-command backup**:

```bash
# WAL-safe SQLite snapshot, taken from INSIDE the running server container so it
# uses the same node:sqlite the app uses (EliteDesk host has no sqlite3 CLI).
cd /home/claudio/projects/3d-model-web-viewer
TS=$(date +%Y%m%d-%H%M%S)
docker compose -f deploy/docker-compose.elitedesk.yml exec -T server \
  node -e "const {DatabaseSync}=require('node:sqlite'); \
    const db=new DatabaseSync('/app/data/db/app.sqlite'); \
    db.exec(\"VACUUM INTO '/app/data/db/app.sqlite.bak-${TS}'\"); \
    db.close(); \
    console.log('WAL-safe backup written: data/db/app.sqlite.bak-'+'${TS}');"
# The snapshot lands in the bind-mounted data/db/ on the host.
```

If the stack is stopped, a plain copy of all three files is also safe:

```bash
cp data/db/app.sqlite{,-wal,-shm} /some/backup/dir/   # only when server is stopped
```

Postgres backup (logical dump, requires the postgres overlay running):

```bash
docker compose -f deploy/docker-compose.elitedesk.yml -f deploy/docker-compose.postgres.yml \
  exec -T postgres pg_dump -U modelbase modelbase \
  > postgres-modelbase-$(date +%Y%m%d-%H%M%S).sql
```

Keep these backups outside the repo (never commit them — `data/` and any
`.sql`/`.sqlite`/`.bak-*` dump are excluded by `.gitignore` for this reason).

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
nothing needs to be reverted in the database.

Full rollback decision list (do only the steps that apply):

1. **Always:** set `AUTH_ENABLED=false` (or remove the line) in `.env` and
   redeploy the default stack (`./scripts/deploy-elitedesk.sh`).
2. **Only if the real model-assignment script was actually run** (not a
   dry-run) and you want to undo it: either restore the WAL-safe SQLite
   snapshot taken before assignment, or run the targeted SQL from
   [How to run real model assignment later](#how-to-run-real-model-assignment-later).
   If assignment was never applied, do **not** restore SQLite — there is
   nothing to undo and a restore would only risk losing legitimate newer
   uploads.
3. **Only if Postgres was started solely for this rollout** and you want to
   stop it: `docker compose -f deploy/docker-compose.elitedesk.yml -f deploy/docker-compose.postgres.yml stop postgres`
   (or `down` the postgres file). This is optional — a running, unused
   Postgres with no host port is harmless. Never run a destructive
   `docker volume rm` / delete of `data/postgres` as part of a rollback.

---

## Rehearsal results — Postgres/accounts enablement dry-run (2026-07-02)

A production-style rehearsal was run against EliteDesk with accounts kept
**disabled** (`AUTH_ENABLED` absent) throughout. No secrets were added, no
OAuth credentials were configured, Postgres was **not** started, and the real
model-assignment script was **not** run.

**Production baseline (read-only, before any change):**

- Git `da0b245` on `main`; `AUTH_ENABLED` absent in `.env`.
- **No accounts env vars are set in production** — no `DATABASE_URL`, no
  `POSTGRES_PASSWORD`/`POSTGRES_USER`/`POSTGRES_DB`, no `GOOGLE_*`, no
  `SESSION_*`, no `AUTH_ALLOWED_EMAILS`.
- `/health` → 200, `/admin` → 401 (legacy Basic auth), `/login` → 404.
- Public/QR flow (token masked): `/public/:token` → 200,
  `/public/:token/model.json` → 200, `/public/:token/model.glb` → 200
  (~23 MB downloadable).
- All other host services (Immich, Plex, Homepage, Portainer, Dozzle, Uptime
  Kuma, the separate `meshiq-phase2c` stack) were running and left untouched.

**1. Postgres overlay validation — PASS (validated, not started).**

- `docker compose -f deploy/docker-compose.elitedesk.yml config --quiet` and the
  same command with `-f deploy/docker-compose.postgres.yml` both validate
  cleanly (the overlay validation passed a throwaway `POSTGRES_PASSWORD` on the
  command line only — nothing was written to `.env`).
- The `postgres` service declares **no published host port** (confirmed against
  the rendered config) — it is reachable only on the project's Docker network.
- It reads `POSTGRES_DB`/`POSTGRES_USER`/`POSTGRES_PASSWORD` from `.env` via
  `env_file`/`${VAR}`; no credentials are hardcoded or committed.
- Data path is `data/postgres` (inside the git-ignored `data/`); it has a
  `pg_isready` healthcheck and `restart: unless-stopped`.
- **Not started.** Bringing it up requires a real `POSTGRES_PASSWORD` in the
  production `.env` (the compose file fails closed without it). Adding a
  database-password secret is out of scope for this rehearsal and is deferred
  to actual enablement.

**2. Auth migration rehearsal — dry-run PASS; real apply deferred.**

- New explicit runner `apps/server/scripts/accounts-migrate-auth-db.mjs`
  applies `src/auth/migrations/*.sql` via `DATABASE_URL` without enabling auth,
  starting the app, or touching SQLite.
- `--dry-run` discovers the two migrations (`0001_auth_init.sql`,
  `0002_audit_org_index.sql`) and opens no connection.
- Apply/rollback/idempotency logic is unit-tested against a fake pool
  (`scripts/lib/authMigrations.test.mjs`) — 8 tests pass, no real Postgres
  needed.
- A real apply is **deferred**: it needs a reachable Postgres, which is not
  started (see item 1).

**3. Accounts preflight — run read-only; reports as designed.**

Preflight (inside the running server container, read-only) reported overall
`FAIL` (expected while accounts env is absent) with:

- `AUTH_ENABLED` unset → false; all required auth env `MISSING`; secure-cookie
  status `WARN` (`NODE_ENV` unset).
- SQLite: `totalModels = 37`, `modelsMissingOrganizationId = 37`,
  `modelsAlreadyAssigned = 0`, `activePublicShares = 5`,
  `assignmentDryRun = "37 model(s) would be stamped"`.
- Postgres: not checked (`--check-db` would report "skipped — DATABASE_URL not
  set" in the current environment).

**4. Model assignment dry-run — SQLite side only (DB side deferred).**

- The SQLite-side numbers that the assignment dry-run reports are already
  produced read-only by preflight above: **37 would be assigned, 0 already
  assigned, 5 active public shares, no suspicious models flagged.**
- The full `assign-models-to-default-org.mjs --dry-run` additionally resolves
  the owner/target-workspace from Postgres, so it cannot complete until
  Postgres is up and an owner exists. That owner/workspace **cannot exist
  without a Google sign-in** (or `--create-owner`), so it is a documented
  blocker deferred to enablement — not forced here. The script was **not** run
  against production.

**5. Backup/rollback docs — updated in this pack.**

- Added a **WAL-safe one-command SQLite backup** using `VACUUM INTO` (the app
  runs `PRAGMA journal_mode = WAL`, so a plain `cp app.sqlite` of a live DB can
  be torn) — see [How to back up SQLite before assignment](#how-to-back-up-sqlite-before-assignment).
- Expanded the rollback section into an explicit decision list (flip
  `AUTH_ENABLED=false` + redeploy default stack; restore SQLite **only** if the
  real assignment was actually run; stop the Postgres overlay **only** if it was
  started for the rollout) — see
  [How to rollback](#how-to-rollback-to-auth_enabled-false).
- Added `.gitignore` rules for `*.sqlite`, `*.sqlite.bak-*`, and
  `postgres-*.sql` dumps so backups can't be committed by accident.

### Remaining blockers before enabling Google login

1. **Register the Google OAuth app** and obtain `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET` (deliberately out of scope until enablement).
2. **Provision production accounts secrets in `.env`**: `DATABASE_URL`,
   `POSTGRES_PASSWORD` (+ `POSTGRES_DB`/`POSTGRES_USER`), `SESSION_SECRET`,
   `APP_BASE_URL`, `SESSION_COOKIE_SECURE=true`, `AUTH_ALLOWED_EMAILS`.
3. **Start the Postgres overlay** (`--with-postgres`) and run
   `accounts-migrate-auth-db.mjs` to apply the auth schema.
4. **Sign in once** with an allow-listed Google email so the owner user +
   Personal Workspace exist, then run the model-assignment **dry-run** for real
   (still no writes) to review the 37-model plan.
5. Only then take backups, run the real assignment, and flip
   `AUTH_ENABLED=true` per the steps above.

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
