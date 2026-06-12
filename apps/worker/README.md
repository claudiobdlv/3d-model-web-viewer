# Fake STEP Processing Worker

This worker exercises the server-side processing contract without running OpenCascade or glTF Transform.

## Configuration

- `SERVER_URL`: server URL. Defaults to `http://192.168.1.100:3009`.
- `WORKER_API_TOKEN`: bearer token expected by the server.
- `POLL_INTERVAL_SECONDS`: delay between polls. Defaults to `15`.
- `WORKER_OUTPUT_DIR`: local working directory. Defaults to `./worker-output`.
- `PLACEHOLDER_GLB`: optional path to a local `.glb` to upload as `display.glb`.
- `RUN_ONCE`: set to `true` to process at most one job and exit.

## Commands

```powershell
npm install
$env:WORKER_API_TOKEN="<same token as server>"
npm run dev -- --once
```

The worker stores downloaded sources and generated fake outputs in `worker-output/`, which is ignored by git.
