#!/usr/bin/env bash
# Source from repo root:  source production-test-playbook/commands.sh
# Helpers for production webhook curls (Railway DNS resolve) and Supabase checks.

set -euo pipefail

_PLAYBOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
_REPO_ROOT="$(cd "$_PLAYBOOK_DIR/.." && pwd)"

# --- Load .env (non-exported keys become available to subshells) ---
load_env() {
  local f="$_REPO_ROOT/.env"
  [[ -f "$f" ]] || { echo "Missing $_REPO_ROOT/.env" >&2; return 1; }
  set -a
  # shellcheck disable=SC1090
  source <(grep -v '^\s*#' "$f" | grep -v '^\s*$' | sed 's/\r$//')
  set +a
}

# --- Railway ---
export RAILWAY_BASE="${WEBHOOK_URL:-https://vaitalcare-production.up.railway.app}"
RAILWAY_BASE="${RAILWAY_BASE%/}"
export RAILWAY_HOST="${RAILWAY_HOST:-$(echo "$RAILWAY_BASE" | sed -E 's#https?://##; s#/.*##')}"
export RAILWAY_RESOLVE_IP="${RAILWAY_RESOLVE_IP:-66.33.22.247}"
export E2E_PHONE_RAW="${E2E_PHONE_RAW:-9685722570}"

_resolve() {
  echo "--resolve" "${RAILWAY_HOST}:443:${RAILWAY_RESOLVE_IP}"
}

# Generic GET/POST to Railway (any path)
railway_curl() {
  local url="$1"
  shift || true
  curl -sS $(_resolve) "$url" "$@"
  echo ""
}

# POST JSON to /webhook/<path>
railway_post_json() {
  local path="$1"
  local body="${2:-{}}"
  local url="${RAILWAY_BASE}/webhook/${path}"
  echo "# POST $url (JSON)"
  curl -sS $(_resolve) -w "\nHTTP %{http_code}\n" -X POST "$url" \
    -H 'Content-Type: application/json' \
    -d "$body"
  echo ""
}

# POST application/x-www-form-urlencoded to /webhook/<path>
railway_post_form() {
  local path="$1"
  local body="$2"
  local url="${RAILWAY_BASE}/webhook/${path}"
  echo "# POST $url (form)"
  curl -sS $(_resolve) -w "\nHTTP %{http_code}\n" -X POST "$url" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d "$body"
  echo ""
}

# --- Supabase verification (delegates to verify.js) ---
verify_patient_state() {
  local phone="${1:-+91${E2E_PHONE_RAW}}"
  node "$_PLAYBOOK_DIR/verify.js" patient "$phone"
}

verify_prescription_delivery() {
  local phone="${1:-+91${E2E_PHONE_RAW}}"
  node "$_PLAYBOOK_DIR/verify.js" prescriptions "$phone"
}

verify_system_logs() {
  local workflow="${1:-workflow-13-prescription-delivery}"
  node "$_PLAYBOOK_DIR/verify.js" logs "$workflow"
}

# Invoke Supabase prescription-delivery edge (needs prescription id in DB)
invoke_prescription_edge() {
  local prescription_id="$1"
  load_env || return 1
  local anon="${SUPABASE_ANON_KEY:-}"
  local url="${SUPABASE_URL}/functions/v1/prescription-delivery"
  echo "# POST $url prescription_id=$prescription_id"
  curl -sS -w "\nHTTP %{http_code}\n" -X POST "$url" \
    -H "apikey: $anon" \
    -H "Authorization: Bearer $anon" \
    -H 'Content-Type: application/json' \
    -d "{\"prescription_id\":\"$prescription_id\"}"
  echo ""
}

echo "production-test-playbook loaded (Railway: $RAILWAY_BASE, resolve IP: $RAILWAY_RESOLVE_IP)"
echo "  railway_post_form patient-form-intake \"phone_number=...\""
echo "  verify_patient_state +91${E2E_PHONE_RAW}"
echo "  npm run test:production-e2e"
