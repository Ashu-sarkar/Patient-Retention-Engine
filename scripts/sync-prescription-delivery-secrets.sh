#!/usr/bin/env bash
# Sync Supabase Edge Function secrets for prescription-delivery from .env
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Missing .env in repo root" >&2
  exit 1
fi

# shellcheck disable=SC1091
source <(grep -E '^(N8N_PRESCRIPTION_DELIVERY_URL|INTERNAL_WEBHOOK_SECRET|DOCTOR_DASHBOARD_ORIGIN|SUPABASE_URL)=' .env | sed 's/^/export /')

PROJECT_REF="${SUPABASE_URL#https://}"
PROJECT_REF="${PROJECT_REF%%.supabase.co*}"

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
  "DOCTOR_DASHBOARD_ORIGIN=${ORIGINS}"

echo "Deploying prescription-delivery function ..."
npx supabase functions deploy prescription-delivery --project-ref "${PROJECT_REF}"

echo "Done. N8N_PRESCRIPTION_DELIVERY_URL=${N8N_URL}"
