#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/claudio/projects/3d-model-web-viewer}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$BACKUP_DIR/3d-model-web-viewer-data-$STAMP.tar.gz"

cd "$APP_DIR"
mkdir -p "$BACKUP_DIR"

tar -czf "$ARCHIVE" \
  data/db \
  data/uploads \
  data/models \
  data/logs

echo "$ARCHIVE"
