#!/bin/sh
# Container entry-point.
# Starts n8n, then idempotently binds credentials, imports latest workflows,
# and activates production webhooks. This keeps Railway restarts from leaving
# webhook workflows in an unregistered/test-only state.
set -e

N8N_PORT="${N8N_PORT:-5678}"
LOCAL_N8N_URL="http://127.0.0.1:${N8N_PORT}"

# Railway does not read docker-compose.yml, so keep the runtime defaults that
# setup-n8n.js depends on here as well. The setup script logs in through the
# container-local HTTP URL; secure cookies prevent that login from returning a
# usable session cookie.
export N8N_SECURE_COOKIE="${N8N_SECURE_COOKIE:-false}"
export N8N_BLOCK_ENV_ACCESS_IN_NODE="${N8N_BLOCK_ENV_ACCESS_IN_NODE:-false}"
export GENERIC_TIMEZONE="${GENERIC_TIMEZONE:-${TIMEZONE:-Asia/Kolkata}}"

echo "[start.sh] Runtime setup:"
echo "[start.sh]   WEBHOOK_URL=${WEBHOOK_URL:-<missing>}"
echo "[start.sh]   N8N_OWNER_EMAIL=${N8N_OWNER_EMAIL:-<missing>}"
echo "[start.sh]   N8N_SECURE_COOKIE=${N8N_SECURE_COOKIE}"
echo "[start.sh]   N8N_BLOCK_ENV_ACCESS_IN_NODE=${N8N_BLOCK_ENV_ACCESS_IN_NODE}"

echo "[start.sh] Starting n8n..."
n8n start &
N8N_PID=$!

cleanup() {
  echo "[start.sh] Stopping n8n..."
  kill "${N8N_PID}" 2>/dev/null || true
}
trap cleanup INT TERM

echo "[start.sh] Waiting for n8n at ${LOCAL_N8N_URL}/healthz..."
for i in $(seq 1 60); do
  if wget -qO- "${LOCAL_N8N_URL}/healthz" >/dev/null 2>&1; then
    echo "[start.sh] n8n is healthy."
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "[start.sh] WARNING: n8n did not become healthy before setup timeout." >&2
    break
  fi
  sleep 2
done

echo "[start.sh] Running production workflow setup..."
if N8N_BASE_URL="${LOCAL_N8N_URL}" node /tests/setup-n8n.js; then
  echo "[start.sh] Workflow setup completed."
else
  echo "[start.sh] ERROR: workflow setup failed; production webhooks may be unregistered." >&2
  echo "[start.sh] Stopping n8n so the platform restarts instead of serving a broken deployment." >&2
  kill "${N8N_PID}" 2>/dev/null || true
  wait "${N8N_PID}" 2>/dev/null || true
  exit 1
fi

wait "${N8N_PID}"
