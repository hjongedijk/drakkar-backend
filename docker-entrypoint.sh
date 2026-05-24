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

db_state() {
  node --input-type=module <<'EOF'
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
try {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
  `);
  const names = Array.isArray(rows) ? rows.map((row) => String(row.table_name ?? "")).filter(Boolean) : [];
  const appTables = names.filter((name) => name !== "_prisma_migrations");
  const hasMigrations = names.includes("_prisma_migrations");
  const hasSetting = names.includes("Setting");
  process.stdout.write(`APP_TABLES=${appTables.length}\nHAS_MIGRATIONS=${hasMigrations ? 1 : 0}\nHAS_SETTING=${hasSetting ? 1 : 0}\n`);
} catch (error) {
  process.stdout.write("APP_TABLES=-1\nHAS_MIGRATIONS=0\nHAS_SETTING=0\n");
  process.stderr.write(`db_state probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
EOF
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

mark_all_migrations_applied() {
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
}

eval "$(db_state || true)"

if [ "${APP_TABLES:-0}" = "0" ] && [ "${HAS_MIGRATIONS:-0}" = "0" ]; then
  push_log="$(mktemp)"
  if npx prisma db push --skip-generate >"$push_log" 2>&1; then
    echo "Prisma fresh database initialized: $(one_line_file "$push_log")"
    rm -f "$push_log"
    mark_all_migrations_applied
    exec node dist/index.js
  fi
  echo "Prisma fresh database initialization failed: $(one_line_file "$push_log")"
  rm -f "$push_log"
  exit 1
fi

if run_migrate_deploy; then
  exec node dist/index.js
fi

if [ "${DRAKKAR_AUTO_BASELINE_MIGRATIONS:-true}" != "true" ]; then
  echo "Prisma migrate deploy failed and DRAKKAR_AUTO_BASELINE_MIGRATIONS is not true."
  exit 1
fi

if [ "${HAS_MIGRATIONS:-0}" = "0" ] && [ "${HAS_SETTING:-0}" = "1" ]; then
  echo "Migration deploy failed. Attempting one-time baseline for existing pre-migration database."
  mark_all_migrations_applied
  run_migrate_deploy
  exec node dist/index.js
fi

echo "Prisma migrate deploy failed and database is not a safe fresh-db or safe baseline case."
exit 1
