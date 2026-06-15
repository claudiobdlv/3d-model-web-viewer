# OpenCascade XCAF STEP metadata spike

This is an isolated investigation tool for checking whether native OpenCascade
XCAF can see STEP assembly metadata, names, layers, materials, and colours that
the current `occt-import-js` converter does not expose reliably.

It does not replace the production converter and does not write GLB files.

```bash
./spikes/occt-xcaf-colour/run.sh /path/to/input.stp /tmp/xcaf-report.json
```

The script prefers Docker so the OpenCascade packages stay outside the app
runtime. If Docker is unavailable, it falls back to a local CMake build with
OpenCascade already installed.
