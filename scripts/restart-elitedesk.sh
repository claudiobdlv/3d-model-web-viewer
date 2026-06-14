#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/claudio/projects/3d-model-web-viewer}"
COMPOSE_FILE="deploy/docker-compose.elitedesk.yml"

cd "$APP_DIR"
docker compose -f "$COMPOSE_FILE" restart server worker
docker compose -f "$COMPOSE_FILE" ps
