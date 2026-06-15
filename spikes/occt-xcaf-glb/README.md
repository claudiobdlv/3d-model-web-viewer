# OpenCascade XCAF STEP to GLB prototype

This is an isolated native OpenCascade/XCAF prototype. It does not replace the
production `occt-import-js` converter and does not touch Docker Compose.

```bash
./spikes/occt-xcaf-glb/run.sh /path/to/input.stp /tmp/u843-xcaf-glb-output high
```

The output directory receives:

- `display.glb`
- `xcaf-report.json`
- `conversion.log`

The runner uses Docker when available, otherwise it falls back to a local CMake
build with OpenCascade development packages already installed.
