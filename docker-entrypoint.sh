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
normalize_service_urls() {
  printf '%s' "$1" | sed \
    -e 's#@postgres:#@drakkar_postgres:#g' \
    -e 's#//valkey:#//drakkar_valkey:#g' \
    -e 's#@valkey:#@drakkar_valkey:#g'
}
if [ -z "${DATABASE_URL:-}" ] && [ -r "$CONFIG_FILE" ]; then
  DATABASE_URL="$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\(postgresql:[^"]*\)".*/\1/p' "$CONFIG_FILE" | head -n 1)"
  DATABASE_URL="$(normalize_service_urls "$DATABASE_URL")"
  export DATABASE_URL
fi
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL="postgresql://postgres:postgres@drakkar_postgres:5432/drakkar"
  export DATABASE_URL
fi
if [ -z "${REDIS_URL:-}" ] && [ -r "$CONFIG_FILE" ]; then
  REDIS_URL="$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\(redis:[^"]*\)".*/\1/p' "$CONFIG_FILE" | head -n 1)"
  REDIS_URL="$(normalize_service_urls "$REDIS_URL")"
  export REDIS_URL
fi
if [ -z "${REDIS_URL:-}" ]; then
  REDIS_URL="redis://drakkar_valkey:6379"
  export REDIS_URL
fi

one_line_file() {
  tr '\n\r\t' '   ' < "$1" | sed 's/  */ /g; s/^ //; s/ $//'
}

ensure_rclone_conf() {
  mkdir -p /data/rclone/cache /mnt/drakkar/media/movies /mnt/drakkar/media/tv

  cleanup_vfs_mountpoint() {
    fusermount -uz /mnt/drakkar/vfs 2>/dev/null || fusermount3 -uz /mnt/drakkar/vfs 2>/dev/null || umount -l /mnt/drakkar/vfs 2>/dev/null || true
    rm -rf /mnt/drakkar/vfs 2>/dev/null || rmdir /mnt/drakkar/vfs 2>/dev/null || true
  }

  cleanup_vfs_mountpoint
  if ! mkdir -p /mnt/drakkar/vfs 2>/dev/null; then
    cleanup_vfs_mountpoint
    sleep 1
    mkdir -p /mnt/drakkar/vfs
  fi
  token="$(node --input-type=module <<'EOF'
import { readFileSync } from "node:fs";

const configPath = `${process.env.CONFIG_DIR || "/data/config"}/settings.json`;
let token = process.env.DRAKKAR_API_TOKEN ?? "";
if (!token) {
  try {
    token = JSON.parse(readFileSync(configPath, "utf8")).drakkarApiToken ?? "";
  } catch {
    token = "";
  }
}
process.stdout.write(token);
EOF
)"
  [ -n "$token" ] || return 0
  obscured="$(RCLONE_PASSWORD="$token" node --input-type=module <<'EOF'
import { createCipheriv, randomBytes } from "node:crypto";

const key = Buffer.from([
  0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d,
  0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
  0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb,
  0xf4, 0xde, 0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38
]);
const password = process.env.RCLONE_PASSWORD ?? "";
const iv = randomBytes(16);
const cipher = createCipheriv("aes-256-ctr", key, iv);
const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
process.stdout.write(Buffer.concat([iv, ciphertext]).toString("base64url"));
EOF
)"
  cat > /data/rclone/rclone.conf <<EOF
[drakkar]
type = webdav
url = http://drakkar_backend:3000/dav
vendor = other
user = admin
pass = $obscured
EOF
  chmod 600 /data/rclone/rclone.conf
}

run_target() {
  if [ "$#" -gt 0 ]; then
    exec "$@"
  fi
  exec node dist/workers/server.js
}

ensure_rclone_conf

db_state() {
  node --input-type=module <<'EOF'
import { PrismaClient } from "./dist/models/generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({
  adapter: new PrismaPg(new pg.Pool({ connectionString: process.env.DATABASE_URL }))
});
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
  if npx prisma db push >"$push_log" 2>&1; then
    echo "Prisma fresh database initialized: $(one_line_file "$push_log")"
    rm -f "$push_log"
    mark_all_migrations_applied
    run_target "$@"
  fi
  echo "Prisma fresh database initialization failed: $(one_line_file "$push_log")"
  rm -f "$push_log"
  exit 1
fi

if run_migrate_deploy; then
  run_target "$@"
fi

if [ "${DRAKKAR_AUTO_BASELINE_MIGRATIONS:-true}" != "true" ]; then
  echo "Prisma migrate deploy failed and DRAKKAR_AUTO_BASELINE_MIGRATIONS is not true."
  exit 1
fi

if [ "${HAS_MIGRATIONS:-0}" = "0" ] && [ "${HAS_SETTING:-0}" = "1" ]; then
  echo "Migration deploy failed. Attempting one-time baseline for existing pre-migration database."
  mark_all_migrations_applied
  run_migrate_deploy
  run_target "$@"
fi

echo "Prisma migrate deploy failed and database is not a safe fresh-db or safe baseline case."
exit 1
