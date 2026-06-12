# Deploying To The Pi

Target:

- Host: `Claudio@192.168.1.100`
- Repo path: `/home/Claudio/3d-model-web-viewer`
- Server path: `/home/Claudio/3d-model-web-viewer/apps/server`
- Port: `3009`
- Service name: `3d-model-web-viewer`

## First Deploy Or Redeploy

```bash
ssh Claudio@192.168.1.100
cd /home/Claudio/3d-model-web-viewer
git pull --ff-only origin main
cd apps/server
npm install
npm run typecheck
npm run build
sudo systemctl restart 3d-model-web-viewer
```

If the repo folder does not exist yet:

```bash
git clone <repo-url> /home/Claudio/3d-model-web-viewer
```

## Runtime Data

Deploys must preserve:

- `apps/server/storage/uploads`
- `apps/server/storage/models`
- `apps/server/storage/*.sqlite`
- `apps/server/storage/*.db`

These paths are ignored by git and should not be deleted during deploy.

## Service

The production command is:

```bash
cd /home/Claudio/3d-model-web-viewer/apps/server
npm start
```

The service should set:

```text
PORT=3009
```

## Validation

After deploy:

```bash
curl -I http://127.0.0.1:3009/
curl http://127.0.0.1:3009/api/models
```

From the local network, open:

```text
http://192.168.1.100:3009
```
