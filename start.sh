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
# setup-n8n.js authenticates through the container-local HTTP URL. Force this
# off so n8n returns a usable session cookie for the setup request path.
export N8N_SECURE_COOKIE=false
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
SETUP_LOG="/tmp/patient-retention-setup.log"
echo "[start.sh] Restoring bundled workflow exports through n8n CLI..."
if n8n import:workflow --separate --input=/workflows >"${SETUP_LOG}.import" 2>&1; then
  cat "${SETUP_LOG}.import"
  echo "[start.sh] Workflow CLI import completed."
else
  echo "[start.sh] WARNING: workflow CLI import failed; REST setup will still attempt import." >&2
  tail -80 "${SETUP_LOG}.import" >&2 || true
fi
echo "[start.sh] Publishing bundled workflows through n8n CLI..."
for WF_ID in \
  wf1-followup-reminder \
  wf2-sameday-reminder \
  wf3-missed-appointment \
  wf4-health-check \
  wf5-reactivation \
  wf6-feedback-listener \
  wf7-new-patient \
  wf8-error-handler \
  wf9-twilio-status-callback \
  wf11-form-intake \
  wf12-hospital-boarding \
  wf13-prescription-delivery
do
  n8n publish:workflow --id="${WF_ID}" || {
    echo "[start.sh] WARNING: could not publish workflow ${WF_ID} through CLI." >&2
  }
done

if N8N_BASE_URL="${LOCAL_N8N_URL}" node /tests/setup-n8n.js >"${SETUP_LOG}" 2>&1; then
  cat "${SETUP_LOG}"
  echo "[start.sh] Workflow setup completed."
else
  echo "[start.sh] ERROR: workflow setup failed; production webhooks may be unregistered." >&2
  echo "[start.sh] Last setup log lines:" >&2
  tail -80 "${SETUP_LOG}" >&2 || true
  echo "[start.sh] Stopping n8n so the platform restarts instead of serving a broken deployment." >&2
  kill "${N8N_PID}" 2>/dev/null || true
  wait "${N8N_PID}" 2>/dev/null || true
  exit 1
fi

echo "[start.sh] Restarting n8n once so published workflow/webhook state is loaded..."
kill "${N8N_PID}" 2>/dev/null || true
wait "${N8N_PID}" 2>/dev/null || true

echo "[start.sh] Starting n8n after workflow setup..."
n8n start &
N8N_PID=$!

echo "[start.sh] Waiting for n8n at ${LOCAL_N8N_URL}/healthz after setup restart..."
for i in $(seq 1 60); do
  if wget -qO- "${LOCAL_N8N_URL}/healthz" >/dev/null 2>&1; then
    echo "[start.sh] n8n is healthy after setup restart."
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "[start.sh] ERROR: n8n did not become healthy after setup restart." >&2
    exit 1
  fi
  sleep 2
done

echo "[start.sh] Verifying production webhook active version..."
LOCAL_N8N_URL="${LOCAL_N8N_URL}" node <<'NODE'
(async () => {
  const base = process.env.LOCAL_N8N_URL || 'http://127.0.0.1:5678';
  const response = await fetch(`${base}/webhook/patient-form-intake`, {
    method: 'POST',
    body: new URLSearchParams({}),
  });
  const text = await response.text();
  if (response.status === 404 || /Active version not found/i.test(text)) {
    throw new Error(`WF11 production webhook is not published: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  console.log(`[start.sh] WF11 webhook mounted (HTTP ${response.status}).`);
})().catch(error => {
  console.error(`[start.sh] ERROR: ${error.message}`);
  process.exit(1);
});
NODE

wait "${N8N_PID}"
