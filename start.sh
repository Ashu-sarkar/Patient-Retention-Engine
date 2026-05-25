#!/bin/sh
# Container entry-point.
# Starts n8n, then idempotently binds credentials, imports latest workflows,
# and activates production webhooks. This keeps Railway restarts from leaving
# webhook workflows in an unregistered/test-only state.
set -e

N8N_PORT="${N8N_PORT:-5678}"
LOCAL_N8N_URL="http://127.0.0.1:${N8N_PORT}"

validate_supabase_env() {
  if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_DB_HOST:-}" ] || [ -z "${SUPABASE_DB_USER:-}" ]; then
    echo "[start.sh] WARNING: Supabase env incomplete; workflow setup may fail." >&2
    return 0
  fi

  PROJECT_REF=$(printf '%s' "$SUPABASE_URL" | sed -n 's|https://\([^.]*\)\.supabase\.co.*|\1|p')
  case "$SUPABASE_DB_HOST" in
    *pooler.supabase.com*)
      if [ "$SUPABASE_DB_USER" = "postgres" ]; then
        echo "[start.sh] ERROR: SUPABASE_DB_USER must be postgres.${PROJECT_REF}, not postgres." >&2
        echo "[start.sh] Use Supabase Dashboard → Connect → Session pooler credentials." >&2
        exit 1
      fi
      if [ -n "$PROJECT_REF" ] && [ "$SUPABASE_DB_USER" != "postgres.${PROJECT_REF}" ]; then
        echo "[start.sh] ERROR: SUPABASE_DB_USER (${SUPABASE_DB_USER}) must be postgres.${PROJECT_REF} for ${SUPABASE_URL}." >&2
        exit 1
      fi
      ;;
  esac
}

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
echo "[start.sh]   SUPABASE_DB_HOST=${SUPABASE_DB_HOST:-<missing>}"
echo "[start.sh]   SUPABASE_DB_USER=${SUPABASE_DB_USER:-<missing>}"

validate_supabase_env

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
# healthz returns 200 as soon as the HTTP server is up, but n8n's internal
# workflow registry and credential cache may still be loading. Give it time
# before the REST setup calls land, otherwise activate can race with init.
echo "[start.sh] Waiting 8 s for n8n internal state to settle before setup..."
sleep 8

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

# setup-n8n.js activates all workflows via REST API, which persists activeVersionId to DB.
# Restart n8n now so the fresh process reloads the DB state and registers webhook routes.
# Do NOT run n8n publish:workflow CLI here — it flips active=false, unregistering webhooks.
echo "[start.sh] Restarting n8n so activated workflow state is reloaded from DB..."
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
# Webhook routes are registered asynchronously after healthz returns 200.
# Wait for n8n to finish loading all active workflow webhooks into Express.
echo "[start.sh] Waiting 10 s for webhook registry to load after restart..."
sleep 10

echo "[start.sh] Verifying production webhook active version..."
LOCAL_N8N_URL="${LOCAL_N8N_URL}" node <<'NODE'
(async () => {
  const base = process.env.LOCAL_N8N_URL || 'http://127.0.0.1:5678';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Retry the probe — webhook routes may still be registering right after boot.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(`${base}/webhook/patient-form-intake`, {
      method: 'POST',
      body: new URLSearchParams({}),
    });
    const text = await response.text();

    if (response.status === 400) {
      console.log(`[start.sh] WF11 webhook mounted and validating input (HTTP 400, attempt ${attempt}).`);
      break;
    }

    const notFound     = response.status === 404 && /Cannot POST/i.test(text);
    const noVersion    = response.status === 404 && /Active version not found/i.test(text);
    const unexpectedOk = response.status === 200;

    if (attempt < 5) {
      const reason = notFound ? 'route not yet registered' : noVersion ? 'activeVersionId not set' : `HTTP ${response.status}`;
      console.log(`[start.sh] Probe attempt ${attempt}/5: ${reason} — retrying in 5 s...`);
      await sleep(5000);
      continue;
    }

    // Final attempt failed — surface the exact failure so Railway logs are actionable.
    if (noVersion) {
      throw new Error(`WF11 activeVersionId is null after restart. Setup activated the workflow but DB state was not reloaded. Body: ${text.slice(0, 300)}`);
    }
    if (notFound) {
      throw new Error(`WF11 webhook route not registered after restart. Workflow may be inactive in DB. Body: ${text.slice(0, 300)}`);
    }
    throw new Error(`WF11 webhook returned unexpected HTTP ${response.status}. Expected 400 validation error. Body: ${text.slice(0, 300)}`);
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    const wf13 = await fetch(`${base}/webhook/prescription-delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const wf13Text = await wf13.text();
    if (wf13.status === 400 && wf13Text.includes('prescription_id')) {
      console.log(`[start.sh] WF13 webhook mounted and validating input (HTTP 400, attempt ${attempt}).`);
      process.exit(0);
    }
    if (attempt < 5) {
      console.log(`[start.sh] WF13 probe attempt ${attempt}/5: HTTP ${wf13.status} — retrying in 5 s...`);
      await sleep(5000);
      continue;
    }
    throw new Error(`WF13 webhook returned unexpected HTTP ${wf13.status}. Expected 400 validation error. Body: ${wf13Text.slice(0, 300)}`);
  }
})().catch(error => {
  console.error(`[start.sh] ERROR: ${error.message}`);
  process.exit(1);
});
NODE

wait "${N8N_PID}"
