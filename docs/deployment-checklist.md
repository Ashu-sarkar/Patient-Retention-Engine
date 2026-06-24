# Deployment Checklist

This is the minimum data needed to launch the current stack:

- Frontend:
  - Patient form URL: `https://vaitalcare-patient.vercel.app/`
  - Hospital form URL: `https://vaitalcare-hospital.vercel.app/`
  - Doctor dashboard URL: `https://vaitalcare-doctor.vercel.app/` (Vercel Root Directory must be `doctor-dashboard`)

- Backend:
  - Railway URL: `https://vaitalcare-production.up.railway.app`

## Railway Variables

Add these to the Railway service:

```env
N8N_BASIC_AUTH_ACTIVE=true
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=
N8N_HOST=vaitalcare-production.up.railway.app
N8N_PORT=5678
N8N_PROTOCOL=https
WEBHOOK_URL=https://vaitalcare-production.up.railway.app
N8N_ENCRYPTION_KEY=
N8N_OWNER_EMAIL=
N8N_OWNER_PASSWORD=
N8N_SECURE_COOKIE=true
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
TIMEZONE=Asia/Kolkata
GENERIC_TIMEZONE=Asia/Kolkata

SUPABASE_URL=https://crsdccqseuhnimoxxeky.supabase.co
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_DB_HOST=aws-1-ap-south-1.pooler.supabase.com
SUPABASE_DB_PORT=5432
SUPABASE_DB_NAME=postgres
SUPABASE_DB_USER=postgres.crsdccqseuhnimoxxeky
SUPABASE_DB_PASSWORD=

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=
TWILIO_STATUS_CALLBACK_URL=https://vaitalcare-production.up.railway.app/webhook/twilio-status-callback

TWILIO_CONTENT_WELCOME=
TWILIO_CONTENT_FOLLOW_UP_REMINDER=
TWILIO_CONTENT_FOLLOWUP_CONFIRMATION=
TWILIO_CONTENT_SAME_DAY_REMINDER=
TWILIO_CONTENT_MISSED_RECOVERY=
TWILIO_CONTENT_MISSED_NUDGE=
TWILIO_CONTENT_HEALTH_CHECK=
TWILIO_CONTENT_REACTIVATION=

MAX_MESSAGE_COUNT=5
MIN_HOURS_BETWEEN_MESSAGES=23
DEFAULT_CLINIC_NAME=VaitalCare
DEFAULT_DOCTOR_NAME=Your Doctor
ADMIN_WHATSAPP_NUMBER=
```

## Must Remove

These must not remain in Railway or `.env`:

```env
WA_PHONE_NUMBER_ID
WA_ACCESS_TOKEN
WA_WEBHOOK_VERIFY_TOKEN
WA_LANGUAGE_CODE
```

## Essential Data Still Missing

These are the values still required from your side before production works:

- `N8N_BASIC_AUTH_PASSWORD`
- `N8N_ENCRYPTION_KEY`
- `N8N_OWNER_EMAIL`
- `N8N_OWNER_PASSWORD`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_PASSWORD`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`
- `ADMIN_WHATSAPP_NUMBER`
- Doctor dashboard `SUPABASE_ANON_KEY`
- Doctor dashboard `PRESCRIPTION_DELIVERY_FUNCTION`
- Supabase Edge Function `prescription-delivery` deployed
- Matching `INTERNAL_WEBHOOK_SECRET` set in n8n and Supabase function secrets
- At least one Supabase Auth doctor user created by hospital onboarding and matching `doctor_profiles` row
- At least one platform admin bootstrapped with `npm run bootstrap:platform-admin`

## Needed For Proactive WhatsApp Templates

These are still missing if you want automated welcome, reminder, missed-visit, health-check, and reactivation sends to work in production:

- `TWILIO_CONTENT_WELCOME`
- `TWILIO_CONTENT_FOLLOW_UP_REMINDER`
- `TWILIO_CONTENT_FOLLOWUP_CONFIRMATION`
- `TWILIO_CONTENT_SAME_DAY_REMINDER`
- `TWILIO_CONTENT_MISSED_RECOVERY`
- `TWILIO_CONTENT_MISSED_NUDGE`
- `TWILIO_CONTENT_HEALTH_CHECK`
- `TWILIO_CONTENT_REACTIVATION`

Without these, inbound replies and free-form session messages can still work, but proactive WhatsApp messaging will not be production-ready.

## Post-Deploy Checks

After Railway variables are added, redeploy once so `start.sh` can import workflows, run setup, publish active versions, restart n8n, and verify webhooks.

Required Supabase pooler user format:

```env
SUPABASE_URL=https://crsdccqseuhnimoxxeky.supabase.co
SUPABASE_DB_HOST=aws-1-ap-south-1.pooler.supabase.com
SUPABASE_DB_USER=postgres.crsdccqseuhnimoxxeky
```

Do **not** use `SUPABASE_DB_USER=postgres` with the session pooler host.

### Automated startup verification

Railway `start.sh` now:

1. Validates `SUPABASE_DB_USER` against `SUPABASE_URL` before boot
2. Imports bundled workflows
3. Runs `tests/setup-n8n.js` (credentials + workflow patch)
4. Publishes every bundled workflow with `n8n publish:workflow --id=...`
5. Restarts n8n so the production webhook registry reloads
6. Probes `POST /webhook/patient-form-intake` and expects HTTP 400 validation (not 404)

If deployment fails or returns 502, inspect Railway logs for `[start.sh] ERROR` and fix env before redeploying.

### Manual verification

```bash
# Health
curl -i https://vaitalcare-production.up.railway.app/healthz

# WF11 should return HTTP 400 validation, not 404 active-version-not-found
curl -i -X POST https://vaitalcare-production.up.railway.app/webhook/patient-form-intake --data ''
```

Healthy webhook response:

```http
HTTP/2 400
{"status":"error","message":"Validation failed",...}
```

If you still see:

```http
HTTP/2 404
{"code":404,"message":"Active version not found for workflow with id \"wf11-form-intake\""}
```

redeploy again and confirm startup logs show `Published wf11-form-intake` followed by `WF11 webhook mounted and validating input (HTTP 400)`.

### n8n UI checks

After Railway variables are added:

1. Open `https://vaitalcare-production.up.railway.app`
2. Confirm n8n login works
3. Confirm WF11, WF12, WF13, WF6, WF7, WF8, and WF9 are active
4. Register Twilio inbound webhook:
   `https://vaitalcare-production.up.railway.app/webhook/feedback-listener`
5. Register Twilio status callback:
   `https://vaitalcare-production.up.railway.app/webhook/twilio-status-callback`
6. Submit one patient form and one hospital form test entry
7. Confirm the patient form creates both `public.patients` and `public.patient_visits`
8. Sign in to the doctor dashboard and confirm the visit appears in the queue
9. Issue a test prescription and confirm a PDF is stored in the `prescriptions` bucket
10. Confirm WF13 logs a `prescription_pdf` row in `message_logs`
11. Run `ADMIN_CONSOLE_URL=<url> ADMIN_USERNAME=<admin> ADMIN_PASSWORD=<password> npm run test:production-admin` to verify admin login, clinic list, QR lifecycle, demo seed/clear, and dashboard counts
