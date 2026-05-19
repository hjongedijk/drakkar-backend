#!/bin/sh
set -eu

SRC="${1:?Usage: backend/scripts/restore.sh .runtime/backups/YYYYmmdd-HHMMSS}"
COMPOSE="${COMPOSE_FILE:-docker-compose.yml}"

test -f "$SRC/postgres.sql"
docker compose -f "$COMPOSE" exec -T postgres psql -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-usenet_vfs}" < "$SRC/postgres.sql"

test -f "$SRC/config.tar.gz" && tar -xzf "$SRC/config.tar.gz" || true
test -f "$SRC/metadata.tar.gz" && tar -xzf "$SRC/metadata.tar.gz" || true
test -f "$SRC/logs.tar.gz" && tar -xzf "$SRC/logs.tar.gz" || true

printf 'Restore completed from %s\n' "$SRC"
