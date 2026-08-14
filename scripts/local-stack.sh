#!/usr/bin/env bash
#
# Bring up the whole local Nova stack: Postgres → dakio-api schema → a seeded
# demo store (8 products, 5 customers, 12 orders) → dakio-api on :5001 →
# nova-mastra on :2100, wired to that store.
#
# The demo tenant id is a cuid generated at seed time, so it cannot be
# hardcoded — this script discovers it and writes it into nova-mastra/.env as
# NOVA_DEV_STORE_ID. Re-running is safe: the seed skips a tenant that already
# has orders.
#
#   ./scripts/local-stack.sh                    # dakio-api assumed at ../dakio-api
#   DAKIO_API_DIR=/path/to/dakio-api ./scripts/local-stack.sh
#
# The one thing this cannot provide is a model credential: put your
# AI_GATEWAY_API_KEY in nova-mastra/.env before the first /chat call.
set -euo pipefail

NOVA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAKIO_API_DIR="${DAKIO_API_DIR:-$(cd "$NOVA_DIR/../dakio-api" && pwd)}"
DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/dakio_db}"
NOVA_SECRET="${NOVA_SERVICE_SECRET:-local-dev-nova-service-secret}"
API_PORT="${API_PORT:-5001}"
LOG_DIR="${LOG_DIR:-/tmp/nova-stack}"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

[ -d "$DAKIO_API_DIR" ] || { echo "dakio-api not found at $DAKIO_API_DIR — set DAKIO_API_DIR"; exit 1; }
mkdir -p "$LOG_DIR"

say "Postgres"
pg_isready -q || { service postgresql start >/dev/null 2>&1 || pg_ctl -D "${PGDATA:-/var/lib/postgresql/data}" start; sleep 3; }
pg_isready
DB_NAME="${DB_URL##*/}"; DB_NAME="${DB_NAME%%\?*}"     # strip any ?connection_limit=…
ADMIN_URL="${DB_URL%/*}/postgres"
psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
  || psql "$ADMIN_URL" -c "CREATE DATABASE \"$DB_NAME\""

say "dakio-api — env, schema, seed"
cd "$DAKIO_API_DIR"
[ -d node_modules ] || npm install --no-audit --no-fund
if [ ! -f .env ]; then
  cat > .env <<EOF
NODE_ENV=development
DATABASE_URL="$DB_URL"
JWT_SECRET="local-dev-jwt-secret-not-for-production"
PORT=$API_PORT
FRONT_URL="http://localhost:5173"
APP_URL="http://localhost:$API_PORT"
EMAIL_PROVIDER="gmail"
SMTP_FROM="Dakio Local <noreply@localhost>"
ADMIN_EMAIL="admin.dakio@gmail.com"
NOVA_SERVICE_SECRET="$NOVA_SECRET"
EOF
  echo "wrote $DAKIO_API_DIR/.env"
fi
# dotenv does not override an already-set variable, so exporting these makes
# the script's own DB and port win over whatever a pre-existing .env carries.
export DATABASE_URL="$DB_URL" PORT="$API_PORT"
npx prisma generate >/dev/null
npx prisma migrate deploy | tail -1
node prisma/seed-plans.js | tail -1
node scripts/seed-local-demo.mjs

STORE_ID=$(node -e "
import('@prisma/client').then(async ({ PrismaClient }) => {
  const p = new PrismaClient()
  const u = await p.user.findFirst({ where: { email: 'admin.dakio@gmail.com' }, select: { tenantId: true } })
  if (!u) { console.error('demo tenant not found'); process.exit(1) }
  process.stdout.write(u.tenantId)
  await p.\$disconnect()
})")
echo "demo store: $STORE_ID"

say "dakio-api on :$API_PORT"
if curl -sf "http://localhost:$API_PORT/api/health" >/dev/null; then
  echo "already running"
else
  (node src/index.js > "$LOG_DIR/dakio-api.log" 2>&1 &)
  for _ in $(seq 20); do sleep 1; curl -sf "http://localhost:$API_PORT/api/health" >/dev/null && break; done
  curl -sf "http://localhost:$API_PORT/api/health" >/dev/null || { tail -20 "$LOG_DIR/dakio-api.log"; exit 1; }
  echo "up (log: $LOG_DIR/dakio-api.log)"
fi

say "nova-mastra env"
cd "$NOVA_DIR"
[ -d node_modules ] || npm install --no-audit --no-fund
[ -f .env ] || cp .env.example .env
# Point .env at the local API, the shared secret and the store we just seeded.
node -e "
const fs = require('node:fs')
const set = (src, key, value) =>
  new RegExp('^' + key + '=.*\$', 'm').test(src)
    ? src.replace(new RegExp('^' + key + '=.*\$', 'm'), key + '=' + value)
    : src.trimEnd() + '\n' + key + '=' + value + '\n'
let env = fs.readFileSync('.env', 'utf8')
env = set(env, 'DAKIO_API_URL', 'http://localhost:$API_PORT')
env = set(env, 'NOVA_SERVICE_SECRET', '$NOVA_SECRET')
env = set(env, 'NOVA_DEV_STORE_ID', '$STORE_ID')
fs.writeFileSync('.env', env)
"
grep -q '^AI_GATEWAY_API_KEY=.\+' .env || echo "  ! AI_GATEWAY_API_KEY is empty in .env — /chat will 500 at the model call"

say "Ready"
cat <<EOF
  store    Dakio Demo Store ($STORE_ID) — login admin.dakio@gmail.com / Test.1234
  api      http://localhost:$API_PORT/api/health
  nova     npm run dev            → http://localhost:2100
  studio   http://localhost:2100/studio
  chat     curl -s localhost:2100/chat -H 'content-type: application/json' -d '{"message":"hello"}'
EOF
