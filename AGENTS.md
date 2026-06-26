# Agent Instructions — 3D Model Web Viewer

Canonical instructions for Codex, Claude Code, and other coding agents working on this repository.

---

## Project identity

- **Repo:** `claudiobdlv/3d-model-web-viewer`
- **Production host:** EliteDesk (`ssh elitedesk`, LAN `192.168.1.200`)
- **Production path:** `/home/claudio/projects/3d-model-web-viewer`
- **Admin UI:** `http://192.168.1.200:3009/admin`
- **Public/QR viewer links are live** — coworkers scan QR codes to view 3D models in the field.

---

## Safety boundaries

These rules apply unless the user prompt explicitly overrides them for a specific named action.

### Services — do not touch
- Raspberry Pi at `192.168.1.100`
- Cloudflare (DNS, tunnels, access policies)
- Plex, Immich, Homepage, Portainer, Dozzle, Uptime Kuma
- Router, firewall, port-forwarding rules, backups

### EliteDesk — restricted actions
- Do **not** restart Docker globally (`docker restart` / `docker compose down` for the whole stack)
- Do **not** reboot the EliteDesk
- Do **not** expose new router ports

### Repository — never commit
- `.env` files or secrets of any kind
- Uploaded STEP files or user-submitted models
- Generated GLB files
- SQLite databases or any runtime DB file
- Runtime logs or benchmark outputs
- QA screenshots or copied production data
- The `data/` directory

---

## Production caution

Production is live and actively used. Before taking any of the following actions, the prompt must explicitly authorise it:

- Deploying to EliteDesk (`scripts/deploy-elitedesk.sh` or equivalent)
- Merging to `main`
- Running database migrations or schema changes
- Mutating production storage (uploads, GLBs, SQLite)

**Preserve public/QR links.** Share URLs and QR codes are sent to coworkers. Never change URL structure or delete records without an explicit migration plan and confirmed backup.

---

## Standard workflow

1. Read relevant files before editing.
2. Keep changes scoped to what the prompt requests.
3. Run type-check, lint, and relevant tests before committing.
4. Commit and push to the branch named in the prompt.
5. Report: files changed, commit hash, checks run, checks skipped and why, risks.

---

## Project map

| Area | Path |
|---|---|
| HTTP server | `apps/server` |
| Web frontend | `apps/web` |
| Background worker | `apps/worker` |
| JS STEP→GLB converter | `apps/converter` |
| Native XCAF converter (spike) | `spikes/occt-xcaf-glb` |
| Compose file | `deploy/docker-compose.elitedesk.yml` |
| Deploy script | `scripts/deploy-elitedesk.sh` |
| Documentation | `docs/` |

---

## Feature-specific notes

### MeshIQ adaptive tessellation (`feature/meshiq-adaptive-tessellation`)

- Adaptive mesh is **default-off** in production. Do not enable it without an explicit prompt.
- Do not apply tiny-dense coarsening or mesh simplification unless explicitly requested.
- Do not commit benchmark artifacts, profiling dumps, or intermediate mesh outputs.

### RevVault revision support

- Revision support is **live in production**.
- Old QR/share URLs must keep working — do not change URL or record structure in a way that breaks existing links.
- Do not mutate the production database or storage without explicit rollout instructions and a confirmed backup.
