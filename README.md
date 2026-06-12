# 3D Model Web Viewer

MVP Express + TypeScript server for uploading and viewing 3D models in the browser.

The first stable baseline supports:

- GLB uploads, copied into viewer-ready storage and displayed with `<model-viewer>`.
- STEP/STP uploads, recorded for the future conversion worker but not processed yet.
- SQLite model/job records using `node:sqlite`.
- A simple model list and per-model viewer page.

The app currently lives in `apps/server` and runs on port `3009`.

## Local Setup

```powershell
cd apps/server
npm install
npm run typecheck
npm run build
npm start
```

Open `http://localhost:3009`.

## Runtime Storage

Do not commit runtime model data. These paths are ignored:

- `apps/server/storage/uploads/`
- `apps/server/storage/models/`
- `apps/server/storage/*.sqlite`
- `apps/server/storage/*.db`

## Worker Pipeline

STEP conversion is intentionally out of scope for this baseline. STEP/STP files can be uploaded and tracked, but they remain `uploaded` until a later worker/conversion pipeline is added.
