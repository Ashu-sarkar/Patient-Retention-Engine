#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Patient Retention Engine — One-command launcher
#
#  Usage:
#    ./launch.sh           # start everything (build if image is stale)
#    ./launch.sh --rebuild # force rebuild of the Docker image
#    ./launch.sh --stop    # stop containers
#    ./launch.sh --status  # print container & workflow status
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
N8N_URL="http://localhost:5678"
COMPOSE="docker compose"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}${BOLD}[launch]${RESET} $*"; }
ok()   { echo -e "${GREEN}✅ $*${RESET}"; }
warn() { echo -e "${YELLOW}⚠️  $*${RESET}"; }
die()  { echo -e "${RED}❌ $*${RESET}" >&2; exit 1; }

# ── Argument handling ─────────────────────────────────────────────────────────
MODE="start"
for arg in "$@"; do
  case "$arg" in
    --rebuild) MODE="rebuild";;
    --stop)    MODE="stop";;
    --status)  MODE="status";;
    --help|-h)
      echo "Usage: ./launch.sh [--rebuild|--stop|--status]"
      exit 0;;
  esac
done

# ── Sanity checks ─────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "Docker not found. Install Docker Desktop first."

if ! docker info >/dev/null 2>&1; then
  die "Docker daemon is not running. Start Docker Desktop and retry."
fi

if [ ! -f "${REPO_DIR}/.env" ]; then
  die ".env file not found at ${REPO_DIR}/.env — copy .env.example and fill in values."
fi

# ── --stop mode ───────────────────────────────────────────────────────────────
if [ "$MODE" = "stop" ]; then
  log "Stopping containers…"
  cd "$REPO_DIR" && $COMPOSE down
  ok "All containers stopped."
  exit 0
fi

# ── --status mode ─────────────────────────────────────────────────────────────
if [ "$MODE" = "status" ]; then
  log "Container status:"
  cd "$REPO_DIR" && $COMPOSE ps
  exit 0
fi

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}${BOLD}║   Patient Retention Engine — Launcher             ║${RESET}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════════╝${RESET}"
echo ""

cd "$REPO_DIR"

# ── Supabase schema + pooler checks (host DB, before Docker) ─────────────────
if command -v node >/dev/null 2>&1; then
  if [ ! -d "${REPO_DIR}/node_modules/pg" ] && command -v npm >/dev/null 2>&1; then
    log "Installing npm dependencies (pg for Supabase preflight)…"
    npm install --no-audit --no-fund --silent
  fi
  log "Running Supabase preflight (schema alignment + PostgREST reload signal)…"
  node "${REPO_DIR}/scripts/preflight-supabase.js" || die "Supabase preflight failed — fix SUPABASE_DB_* pooler settings and SQL errors above, or set SKIP_SUPABASE_PREFLIGHT=1 to skip."
else
  die "Node.js is required for scripts/preflight-supabase.js (install Node 18+)."
fi

# ── Build / start ─────────────────────────────────────────────────────────────
if [ "$MODE" = "rebuild" ]; then
  log "Forcing a clean image rebuild…"
  $COMPOSE build --no-cache
fi

log "Starting containers (docker compose up -d)…"
$COMPOSE up -d --build

# ── Wait for healthcheck ──────────────────────────────────────────────────────
log "Waiting for n8n to be healthy…"
MAX_WAIT=90
ELAPSED=0
while true; do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' \
    "$(docker compose ps -q n8n 2>/dev/null)" 2>/dev/null || echo "unknown")

  if [ "$STATUS" = "healthy" ]; then
    ok "n8n is healthy!"
    break
  fi

  # Also check /healthz directly in case healthcheck metadata is not yet populated
  if curl -sf "${N8N_URL}/healthz" >/dev/null 2>&1; then
    ok "n8n responded to /healthz"
    break
  fi

  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    warn "n8n took more than ${MAX_WAIT}s. Check logs with: docker compose logs -f n8n"
    break
  fi
  sleep 3
  ELAPSED=$((ELAPSED + 3))
  printf '.'
done
echo ""

# ── Run setup (credentials + workflow activation) ─────────────────────────────
if command -v node >/dev/null 2>&1; then
  log "Running setup-n8n.js (credentials + workflow patching)…"
  node "${REPO_DIR}/tests/setup-n8n.js" || warn "Setup script reported errors — check output above."
else
  warn "Node.js not found — skipping automated setup."
  warn "Install Node.js and run: node tests/setup-n8n.js"
fi

# ── Open browser ──────────────────────────────────────────────────────────────
echo ""
ok "Engine is running at ${N8N_URL}"
echo ""
log "Opening n8n in your default browser…"
if command -v open >/dev/null 2>&1; then       # macOS
  open "${N8N_URL}"
elif command -v xdg-open >/dev/null 2>&1; then # Linux
  xdg-open "${N8N_URL}"
else
  warn "Could not auto-open browser. Navigate to: ${N8N_URL}"
fi

echo ""
echo -e "${GREEN}${BOLD}Login:${RESET}"
echo "  URL:      ${N8N_URL}"
echo "  Email:    $(grep N8N_OWNER_EMAIL "${REPO_DIR}/.env" 2>/dev/null | cut -d= -f2 || echo 'sarkar.ashu15@gmail.com')"
echo "  Password: (from .env → N8N_OWNER_PASSWORD or Ashu1501@)"
echo ""
echo -e "${CYAN}Useful commands:${RESET}"
echo "  docker compose logs -f n8n   # stream logs"
echo "  ./launch.sh --stop           # stop everything"
echo "  ./launch.sh --rebuild        # rebuild image and restart"
echo "  ./launch.sh --status         # container health"
echo ""
