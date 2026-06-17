# 3D Model Web Viewer

Express + TypeScript server, Vite/React/Tailwind frontend, worker, and STEP/STP
converter for uploading and viewing 3D models in the browser.

The MVP supports:

- Admin-only ModelBase file manager.
- Fullscreen Three.js GLB viewer with object metadata picking.
- Protected admin upload page using `ADMIN_PASSWORD` in deployed environments.
- GLB uploads, copied into viewer-ready storage and displayed immediately.
- STEP/STP uploads, queued for the worker and converted to GLB by `apps/converter`.
- SQLite model/job records using `node:sqlite`.
- Original and converted GLB download links.

The app currently runs on port `3009`.

## Local Setup

```powershell
cd apps/web
npm install
npm run build

cd apps/server
npm install
npm run typecheck
npm run build
npm start
```

Open `http://localhost:3009`.

For worker testing, start the server with `WORKER_API_TOKEN` set, then run:

```powershell
cd apps/worker
npm install
$env:WORKER_API_TOKEN="dev-worker-token"
$env:SERVER_URL="http://localhost:3009"
npm start
```

For the EliteDesk Docker deployment and Cloudflare Tunnel steps, see
`README_DEPLOY_ELITEDESK.md`.

## Runtime Storage

Do not commit runtime model data. These paths are ignored:

- `data/`
- `apps/server/storage/uploads/`
- `apps/server/storage/models/`
- `apps/server/storage/*.sqlite`
- `apps/server/storage/*.db`

## Worker Pipeline

STEP/STP jobs move from `uploaded` to `processing`, then `ready` or `failed`.
The worker stores `display.glb`, `stats.json`, and `conversion.log` for each
conversion.
