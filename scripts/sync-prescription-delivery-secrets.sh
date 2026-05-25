#!/usr/bin/env bash
# Sync Supabase Edge Function secrets for prescription-delivery from .env
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Missing .env in repo root" >&2
  exit 1
fi

set -a
while IFS= read -r line || [[ -n "${line}" ]]; do
  [[ "${line}" =~ ^# ]] && continue
  [[ "${line}" == *"="* ]] || continue
  case "${line%%=*}" in
    N8N_PRESCRIPTION_DELIVERY_URL|INTERNAL_WEBHOOK_SECRET|DOCTOR_DASHBOARD_ORIGIN|SUPABASE_URL|TWILIO_ACCOUNT_SID|TWILIO_AUTH_TOKEN|TWILIO_WHATSAPP_FROM|TWILIO_CONTENT_PRESCRIPTION_DELIVERY|TWILIO_STATUS_CALLBACK_URL)
      export "${line%%=*}=${line#*=}"
      ;;
  esac
done < .env
set +a

PROJECT_REF="$(echo "${SUPABASE_URL:-}" | sed -n 's|https://\([^.]*\)\.supabase\.co.*|\1|p')"

if [[ -z "${PROJECT_REF}" ]]; then
  echo "Could not parse project ref from SUPABASE_URL" >&2
  exit 1
fi

N8N_URL="${N8N_PRESCRIPTION_DELIVERY_URL%/}"
if [[ "${N8N_URL}" != */webhook/prescription-delivery ]]; then
  N8N_URL="${N8N_URL}/webhook/prescription-delivery"
fi

ORIGINS="https://vaitalcare-doctor.vercel.app"
if [[ -n "${DOCTOR_DASHBOARD_ORIGIN:-}" ]]; then
  ORIGINS="${ORIGINS},${DOCTOR_DASHBOARD_ORIGIN}"
fi

echo "Setting Supabase secrets on project ${PROJECT_REF} ..."
npx supabase secrets set --project-ref "${PROJECT_REF}" \
  "N8N_PRESCRIPTION_DELIVERY_URL=${N8N_URL}" \
  "INTERNAL_WEBHOOK_SECRET=${INTERNAL_WEBHOOK_SECRET}" \
  "DOCTOR_DASHBOARD_ORIGIN=${ORIGINS}" \
  "TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID}" \
  "TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN}" \
  "TWILIO_WHATSAPP_FROM=${TWILIO_WHATSAPP_FROM}" \
  "TWILIO_CONTENT_PRESCRIPTION_DELIVERY=${TWILIO_CONTENT_PRESCRIPTION_DELIVERY}" \
  "TWILIO_STATUS_CALLBACK_URL=${TWILIO_STATUS_CALLBACK_URL:-}"

echo "Deploying prescription edge functions ..."
npx supabase functions deploy prescription-delivery --project-ref "${PROJECT_REF}"
npx supabase functions deploy prescription-pdf --project-ref "${PROJECT_REF}" --no-verify-jwt

echo "Done. WhatsApp delivery uses edge function + short PDF link."
