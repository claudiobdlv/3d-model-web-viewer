# EliteDesk MVP Deployment

This deployment keeps the 3D Model Web Viewer entirely on the HP EliteDesk.
It does not use the Raspberry Pi, does not require router port forwarding, and
does not modify any existing Pi/OpenSprinkler Cloudflare Tunnel.

## What Runs

- Express web/API server on local port `3009`
- Worker container that polls the server and runs the selected converter backend
- Persistent local folders under `./data`
- Optional separate Cloudflare Tunnel installed directly on the EliteDesk

Persistent layout:

```text
data/db/app.sqlite
data/uploads/<model-id>/original.step
data/models/<model-id>/display.glb
data/models/<model-id>/stats.json
data/models/<model-id>/material-debug.json
data/logs/<model-id>/conversion.log
```

## First-Time EliteDesk Setup

Run on the EliteDesk as user `claudio`:

```bash
mkdir -p /home/claudio/projects
cd /home/claudio/projects
git clone https://github.com/claudiobdlv/3d-model-web-viewer.git
cd 3d-model-web-viewer
cp .env.example .env
nano .env
```

Set strong private values in `.env`:

```bash
ADMIN_PASSWORD=replace-with-a-strong-admin-password
WORKER_API_TOKEN=replace-with-a-long-random-worker-token
PORT=3009
DATA_DIR=/app/data
SERVER_URL=http://server:3009
POLL_INTERVAL_SECONDS=15
WORKER_OUTPUT_DIR=/app/worker-output
CONVERTER_CLI=/app/apps/converter/src/cli.js
CONVERTER_BACKEND=occt-js
XCAF_CONVERTER_BIN=/app/bin/xcaf-step-to-glb
XCAF_COLOUR_MODE=xcaf-baseline
CONVERTER_QUALITY=high
MATERIAL_RULES_MODE=fallback
MATERIAL_RULES_PATH=/app/config/material-rules.json
```

Converter quality presets:

- `fast`: quicker, rougher tessellation for checks.
- `balanced`: default middle ground.
- `high`: smoother curved fittings and round parts while preserving hard CAD
  face boundaries; recommended for the current MVP.
- `detailed`: alias of the high-quality settings for now.

Material rule modes:

- `off`: use only colours exposed by the STEP import.
- `fallback`: keep STEP face, mesh, and inherited colours when present; use
  editable rules only for otherwise uncoloured meshes.
- `override`: use matching rules before STEP colours. Use this when Rhino shows
  a consistent assembly/layer/block colour scheme but the web conversion only
  preserves it on some repeated parts.

The default rules file is `config/material-rules.json`. It is mounted into the
worker at `/app/config/material-rules.json`, so rule changes can be made without
editing converter code.

Converter backend options:

- `CONVERTER_BACKEND=occt-js`: uses the existing JavaScript `occt-import-js`
  converter and honours `MATERIAL_RULES_MODE`.
- `CONVERTER_BACKEND=xcaf-baseline`: uses the native OpenCascade/XCAF baseline
  converter built into the worker image. It writes `display.glb`,
  `xcaf-report.json`, `stats.json`, `material-debug.json`, and `conversion.log`.
  This backend disables material rules, name guesses, layer-name guesses, active
  raw STEP styled-item colour assignment, layer-colour assignment, and default
  sRGB-to-linear conversion. The worker passes `XCAF_COLOUR_MODE` from `.env`
  to the native converter as `--colour-mode <mode> --colour-space raw`.

Native XCAF colour modes:

- `XCAF_COLOUR_MODE=xcaf-baseline`: direct OpenCascade/XCAF colours only.
- `XCAF_COLOUR_MODE=step-presentation`: direct XCAF colours still win, then
  explicit STEP `STYLED_ITEM` presentation colours are mapped to matching
  exported BREP/shell topology. Compound objects with multiple styled BREP
  targets are split into matching GLB node/material groups when the exported
  topology count is exact.

Verify the backend used by an upload from the worker and conversion logs:

```bash
docker compose -f deploy/docker-compose.elitedesk.yml logs worker | grep 'Converter backend'
docker compose -f deploy/docker-compose.elitedesk.yml logs worker | grep 'XCAF colour mode'
grep 'Converter backend' data/logs/<model-id>/conversion.log
grep 'XCAF colour mode' data/logs/<model-id>/conversion.log
```

Start only this project:

```bash
chmod +x scripts/*.sh
./scripts/deploy-elitedesk.sh
```

LAN check from another computer:

```powershell
Invoke-WebRequest http://192.168.1.200:3009/health
```

Open:

- Protected admin/upload: `http://192.168.1.200:3009/admin`
- Shared read-only viewer link: `http://192.168.1.200:3009/3dviewer/<slug>`

The admin page uses HTTP Basic Auth. The username can be anything; the password
must match `ADMIN_PASSWORD`.

The app no longer exposes a public list of uploaded models. `/` redirects to
`/admin`; public users should receive direct `/3dviewer/<slug>` links only.

## Day-2 Commands

Update/build/start only this project:

```bash
cd /home/claudio/projects/3d-model-web-viewer
./scripts/deploy-elitedesk.sh
```

Restart only this project's Compose services:

```bash
./scripts/restart-elitedesk.sh
```

Inspect server/worker logs:

```bash
./scripts/logs-elitedesk.sh
```

Create a timestamped backup:

```bash
./scripts/backup-elitedesk.sh
```

## Cloudflare Tunnel

Use Option A: install a separate Cloudflare Tunnel directly on the EliteDesk.
Do not touch the Pi tunnel, Pi services, or router ports.

Install `cloudflared` on Ubuntu/Debian:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update
sudo apt-get install cloudflared
```

Authenticate. This step opens a Cloudflare browser login and must be completed
manually:

```bash
cloudflared tunnel login
```

Create the tunnel:

```bash
cloudflared tunnel create viewer-elitedesk
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: viewer-elitedesk
credentials-file: /home/claudio/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: viewer.parametricstandards.com
    service: http://localhost:3009
  - service: http_status:404
```

Replace `<tunnel-id>` with the tunnel credential JSON filename created by
`cloudflared tunnel create`.

Create the Cloudflare DNS route:

```bash
cloudflared tunnel route dns viewer-elitedesk viewer.parametricstandards.com
```

Install the systemd service:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

Internet check:

```bash
curl -I https://viewer.parametricstandards.com
```

## MVP Limitations

- STEP color accuracy depends on the selected converter. `occt-js` depends on
  what `occt-import-js` exposes and can use material rules as a fallback. The
  `xcaf-baseline` backend uses direct OpenCascade/XCAF metadata only, so it may
  leave components neutral grey when the STEP file does not expose face,
  subshape, owning-label, referred-label, or ancestor colours through XCAF.
  Set `XCAF_COLOUR_MODE=step-presentation` when the STEP file carries explicit
  presentation colours on `STYLED_ITEM` BREP/shell targets that must be mapped
  to exported topology.
- Each conversion writes `material-debug.json` beside `stats.json`. Inspect it
  to see mesh names, hierarchy paths, source colour presence, final material
  colours, and whether a rule matched. Tune `config/material-rules.json`, then
  reconvert the model to apply new rules.
- `CONVERTER_QUALITY=high` improves curved fittings and round parts at the
  cost of longer conversion time and larger GLBs. It still keeps planar CAD
  panels flat and avoids smoothing across hard CAD face edges. Use `balanced`
  if mobile load time or conversion time becomes more important than edge
  smoothness.
- Some STEP files may fail conversion. Failed jobs are marked `failed`, and the
  admin page links to conversion logs when available.
- Large files can take minutes and significant CPU/RAM during `OCCT ReadStepFile`.
- Storage grows under `./data`; use `scripts/backup-elitedesk.sh` and add a
  retention policy later if needed.
