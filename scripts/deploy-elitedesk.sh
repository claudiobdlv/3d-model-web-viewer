#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/claudio/projects/3d-model-web-viewer}"
COMPOSE_FILE="deploy/docker-compose.elitedesk.yml"

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Missing .env in $APP_DIR. Create it from .env.example before deploying." >&2
  exit 1
fi

mkdir -p data/db data/uploads data/models data/logs data/worker-output
SERVICES="$(docker compose -f "$COMPOSE_FILE" config --services)"
if [ "$SERVICES" != "$(printf 'server\nworker')" ]; then
  echo "Unexpected Compose services in $COMPOSE_FILE:" >&2
  printf '%s\n' "$SERVICES" >&2
  exit 1
fi
git pull --ff-only
docker compose -f "$COMPOSE_FILE" up -d --build
docker compose -f "$COMPOSE_FILE" ps
