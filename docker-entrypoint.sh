#!/bin/sh
set -eu

export CI=true
export NO_COLOR=1
export TERM=dumb
export NPM_CONFIG_AUDIT=false
export NPM_CONFIG_FUND=false
export NPM_CONFIG_UPDATE_NOTIFIER=false
export NPM_CONFIG_LOGLEVEL=error

CONFIG_FILE="${CONFIG_DIR:-/data/config}/settings.json"
if [ -z "${DATABASE_URL:-}" ] && [ -r "$CONFIG_FILE" ]; then
  DATABASE_URL="$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\(postgresql:[^"]*\)".*/\1/p' "$CONFIG_FILE" | head -n 1)"
  export DATABASE_URL
fi
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL="postgresql://postgres:postgres@postgres:5432/drakkar"
  export DATABASE_URL
fi

one_line_file() {
  tr '\n\r\t' '   ' < "$1" | sed 's/  */ /g; s/^ //; s/ $//'
}

run_migrate_deploy() {
  log_file="$(mktemp)"
  if npx prisma migrate deploy >"$log_file" 2>&1; then
    echo "Prisma migrations applied: $(one_line_file "$log_file")"
    rm -f "$log_file"
    return 0
  fi
  echo "Prisma migrate deploy failed: $(one_line_file "$log_file")"
  rm -f "$log_file"
  return 1
}

if run_migrate_deploy; then
  exec node dist/index.js
fi

if [ "${DRAKKAR_AUTO_BASELINE_MIGRATIONS:-true}" != "true" ]; then
  echo "Prisma migrate deploy failed and DRAKKAR_AUTO_BASELINE_MIGRATIONS is not true."
  exit 1
fi

echo "Migration deploy failed. Attempting one-time baseline for existing pre-migration database."
for migration in prisma/migrations/*; do
  [ -d "$migration" ] || continue
  name="$(basename "$migration")"
  resolve_log="$(mktemp)"
  if npx prisma migrate resolve --applied "$name" >"$resolve_log" 2>&1; then
    echo "Prisma migration baseline marked applied: $name"
  else
    echo "Prisma migration baseline skipped: $name $(one_line_file "$resolve_log")"
  fi
  rm -f "$resolve_log"
done

run_migrate_deploy
exec node dist/index.js
