# EliteDesk MVP Deployment

This deployment keeps the 3D Model Web Viewer entirely on the HP EliteDesk.
It does not use the Raspberry Pi, does not require router port forwarding, and
does not modify any existing Pi/OpenSprinkler Cloudflare Tunnel.

## What Runs

- Express web/API server on local port `3009`
- Worker container that polls the server and runs the existing converter CLI
- Persistent local folders under `./data`
- Optional separate Cloudflare Tunnel installed directly on the EliteDesk

Persistent layout:

```text
data/db/app.sqlite
data/uploads/<model-id>/original.step
data/models/<model-id>/display.glb
data/models/<model-id>/stats.json
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
CONVERTER_QUALITY=balanced
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

- Public model list: `http://192.168.1.200:3009/`
- Protected admin/upload: `http://192.168.1.200:3009/admin`

The admin page uses HTTP Basic Auth. The username can be anything; the password
must match `ADMIN_PASSWORD`.

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

- STEP color accuracy depends on what `occt-import-js` exposes and may not
  perfectly match the original CAD source.
- Some STEP files may fail conversion. Failed jobs are marked `failed`, and the
  admin page links to conversion logs when available.
- Large files can take minutes and significant CPU/RAM during `OCCT ReadStepFile`.
- Storage grows under `./data`; use `scripts/backup-elitedesk.sh` and add a
  retention policy later if needed.
