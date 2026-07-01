#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/claudio/projects/3d-model-web-viewer}"
COMPOSE_FILE="deploy/docker-compose.elitedesk.yml"
POSTGRES_COMPOSE_FILE="deploy/docker-compose.postgres.yml"

# Opt-in Postgres overlay for later accounts enablement. Default behavior is
# UNCHANGED (server+worker only, no Postgres, no auth enablement) unless one
# of these is explicitly set:
#   INCLUDE_POSTGRES=true ./scripts/deploy-elitedesk.sh
#   ./scripts/deploy-elitedesk.sh --with-postgres
INCLUDE_POSTGRES="${INCLUDE_POSTGRES:-false}"
for arg in "$@"; do
  case "$arg" in
    --with-postgres) INCLUDE_POSTGRES=true ;;
  esac
done

COMPOSE_ARGS=(-f "$COMPOSE_FILE")
EXPECTED_SERVICES="$(printf 'server\nworker\n')"
if [ "$INCLUDE_POSTGRES" = "true" ]; then
  COMPOSE_ARGS+=(-f "$POSTGRES_COMPOSE_FILE")
  EXPECTED_SERVICES="$(printf 'postgres\nserver\nworker\n')"
fi

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Missing .env in $APP_DIR. Create it from .env.example before deploying." >&2
  exit 1
fi

mkdir -p data/db data/uploads data/models data/logs data/worker-output
SERVICES="$(docker compose "${COMPOSE_ARGS[@]}" config --services | sort)"
if [ "$SERVICES" != "$(printf '%s' "$EXPECTED_SERVICES" | sort)" ]; then
  echo "Unexpected Compose services for this deploy mode (INCLUDE_POSTGRES=$INCLUDE_POSTGRES):" >&2
  printf '%s\n' "$SERVICES" >&2
  exit 1
fi
git pull --ff-only
docker compose "${COMPOSE_ARGS[@]}" up -d --build
docker compose "${COMPOSE_ARGS[@]}" ps
