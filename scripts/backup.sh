#!/bin/sh
set -eu

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="${1:-.runtime/backups/$STAMP}"
COMPOSE="${COMPOSE_FILE:-docker-compose.yml}"
RUNTIME_DIR="${RUNTIME_DIR:-.runtime}"

mkdir -p "$DEST"
docker compose -f "$COMPOSE" exec -T postgres pg_dump -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-usenet_vfs}" > "$DEST/postgres.sql"

tar -czf "$DEST/config.tar.gz" "$RUNTIME_DIR/config" 2>/dev/null || true
tar -czf "$DEST/metadata.tar.gz" "$RUNTIME_DIR/vfs/.metadata" "$RUNTIME_DIR/vfs/.ids" 2>/dev/null || true
tar -czf "$DEST/logs.tar.gz" "$RUNTIME_DIR/logs" 2>/dev/null || true

printf 'Backup written to %s\n' "$DEST"
