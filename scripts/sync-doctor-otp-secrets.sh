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
    SUPABASE_URL|TWILIO_ACCOUNT_SID|TWILIO_AUTH_TOKEN|TWILIO_WHATSAPP_FROM|TWILIO_STATUS_CALLBACK_URL|SEND_SMS_HOOK_SECRETS)
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
  echo "Generated SEND_SMS_HOOK_SECRETS. Add this line to .env:"
  echo "SEND_SMS_HOOK_SECRETS=${SEND_SMS_HOOK_SECRETS}"
fi

echo "Setting Supabase secrets on project ${PROJECT_REF} ..."
npx supabase secrets set --project-ref "${PROJECT_REF}" \
  "SEND_SMS_HOOK_SECRETS=${SEND_SMS_HOOK_SECRETS}" \
  "TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID}" \
  "TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN}" \
  "TWILIO_WHATSAPP_FROM=${TWILIO_WHATSAPP_FROM}" \
  "TWILIO_STATUS_CALLBACK_URL=${TWILIO_STATUS_CALLBACK_URL:-}"

echo "Deploying send-sms-hook edge function ..."
npx supabase functions deploy send-sms-hook --project-ref "${PROJECT_REF}" --no-verify-jwt

echo "Pushing auth hook config ..."
npx supabase config push --project-ref "${PROJECT_REF}"

echo "Done. Doctor dashboard OTP is delivered via send-sms-hook -> Twilio WhatsApp."
