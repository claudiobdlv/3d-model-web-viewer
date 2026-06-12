# 3D Viewer MVP

Lightweight local 3D model viewer skeleton for upload, model listing, GLB display, and future conversion jobs.

## Install

```powershell
cd apps/server
npm install
```

## Run

```powershell
npm run dev
```

Open:

```text
http://localhost:3009
```

## Test With A GLB

1. Open `http://localhost:3009`.
2. Upload a `.glb` file.
3. The file appears in the uploaded model list with status `ready`.
4. Click `Open`.
5. The model loads through Google `<model-viewer>` from `/model-files/<slug>/display.glb`.

## Test With A STEP Or STP

1. Upload a `.step` or `.stp` file.
2. The file appears in the uploaded model list with status `uploaded`.
3. Click `Open`.
4. The viewer page says `Model not processed yet`.

## Storage

Uploaded source files are saved under:

```text
storage/uploads/<slug>/
```

Viewer-ready model files and manifests are saved under:

```text
storage/models/<slug>/
```

SQLite records are stored in:

```text
storage/viewer.sqlite
```

## Future Worker

The current server only creates model and job records. A future worker running on the PC can read jobs with status `uploaded`, convert STEP to GLB using OpenCascade, optimize the GLB with glTF Transform, write `storage/models/<slug>/display.glb`, update `manifest.json`, and mark the model/job as `ready`.
