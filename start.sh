#!/bin/sh
# Container entry-point.
# Starts n8n, then idempotently binds credentials, imports latest workflows,
# and activates production webhooks. This keeps Railway restarts from leaving
# webhook workflows in an unregistered/test-only state.
set -e

N8N_PORT="${N8N_PORT:-5678}"
LOCAL_N8N_URL="http://127.0.0.1:${N8N_PORT}"

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
  echo "[start.sh] WARNING: workflow setup failed. n8n will keep running." >&2
fi

wait "${N8N_PID}"
