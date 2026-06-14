#!/usr/bin/env bash
# Deploy doctor-login OTP delivery via Supabase Send SMS hook + Twilio WhatsApp.
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
    SUPABASE_URL|SUPABASE_ACCESS_TOKEN|TWILIO_ACCOUNT_SID|TWILIO_AUTH_TOKEN|TWILIO_WHATSAPP_FROM|TWILIO_STATUS_CALLBACK_URL|SEND_SMS_HOOK_SECRETS)
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

if [[ -z "${SEND_SMS_HOOK_SECRETS:-}" ]]; then
  SEND_SMS_HOOK_SECRETS="v1,whsec_$(openssl rand -base64 32)"
  printf '\nSEND_SMS_HOOK_SECRETS=%s\n' "${SEND_SMS_HOOK_SECRETS}" >> .env
  echo "Saved SEND_SMS_HOOK_SECRETS to .env"
fi

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "Supabase CLI is not authenticated." >&2
  echo "Create a token at https://supabase.com/dashboard/account/tokens" >&2
  echo "Then either:" >&2
  echo "  1. Add SUPABASE_ACCESS_TOKEN=<token> to .env and rerun this script" >&2
  echo "  2. Run: npx supabase login" >&2
  exit 1
fi

export SUPABASE_ACCESS_TOKEN

echo "Setting Supabase secrets on project ${PROJECT_REF} ..."
npx supabase secrets set --project-ref "${PROJECT_REF}" \
  "SEND_SMS_HOOK_SECRETS=${SEND_SMS_HOOK_SECRETS}" \
  "TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID}" \
  "TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN}" \
  "TWILIO_WHATSAPP_FROM=${TWILIO_WHATSAPP_FROM}" \
  "TWILIO_STATUS_CALLBACK_URL=${TWILIO_STATUS_CALLBACK_URL:-}"

echo "Deploying send-sms-hook edge function ..."
npx supabase functions deploy send-sms-hook --project-ref "${PROJECT_REF}" --no-verify-jwt --use-api

echo "Pushing auth hook config ..."
npx supabase config push --project-ref "${PROJECT_REF}"

echo "Done. Doctor dashboard OTP is delivered via send-sms-hook -> Twilio WhatsApp."
