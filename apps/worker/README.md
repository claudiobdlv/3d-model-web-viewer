# STEP Processing Worker

This worker polls the server-side processing contract and converts uploaded STEP/STP files through the selected converter backend.

## Configuration

- `SERVER_URL`: server URL. Defaults to `http://localhost:3009`.
- `WORKER_API_TOKEN`: bearer token expected by the server.
- `POLL_INTERVAL_SECONDS`: delay between polls. Defaults to `15`.
- `WORKER_OUTPUT_DIR`: local working directory. Defaults to `./worker-output`.
- `KEEP_WORKER_OUTPUT`: keep downloaded source and intermediate converter output after success. Defaults to `true`; set to `false` to clean the per-job worker-output directory after the server accepts the completed job.
- `RUN_ONCE`: set to `true` to process at most one job and exit.
- `CONVERTER_BACKEND`: `occt-js` or `xcaf-baseline`. Defaults to `occt-js`.
- `CONVERTER_CLI`: JavaScript `occt-import-js` converter path for `occt-js`.
- `XCAF_CONVERTER_BIN`: native OpenCascade/XCAF converter binary for `xcaf-baseline`.
- `CONVERTER_QUALITY`: `fast`, `balanced`, `high`, or `detailed`. `xcaf-baseline` maps `fast` to native `preview` and `detailed` to native `high`.

When `CONVERTER_BACKEND=xcaf-baseline`, material rules are not applied. The worker calls the native converter with `--colour-mode xcaf-baseline --colour-space raw`, uploads `display.glb`, `stats.json`, `material-debug.json`, `conversion.log`, and `xcaf-report.json`, and logs `Converter backend: xcaf-baseline` for verification.

## Commands

```powershell
npm install
$env:WORKER_API_TOKEN="<same token as server>"
npm run dev -- --once
```

The worker stores downloaded sources and generated converter outputs in `worker-output/`, which is ignored by git.
