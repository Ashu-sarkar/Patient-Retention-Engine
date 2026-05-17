# Deployment Checklist

This is the minimum data needed to launch the current stack:

- Frontend:
  - Patient form URL: `https://vaitalcare-patient.vercel.app/`
  - Hospital form URL: `https://vaitalcare-hospital.vercel.app/`

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

## Needed For Proactive WhatsApp Templates

These are still missing if you want automated welcome, reminder, missed-visit, health-check, and reactivation sends to work in production:

- `TWILIO_CONTENT_WELCOME`
- `TWILIO_CONTENT_FOLLOW_UP_REMINDER`
- `TWILIO_CONTENT_SAME_DAY_REMINDER`
- `TWILIO_CONTENT_MISSED_RECOVERY`
- `TWILIO_CONTENT_MISSED_NUDGE`
- `TWILIO_CONTENT_HEALTH_CHECK`
- `TWILIO_CONTENT_REACTIVATION`

Without these, inbound replies and free-form session messages can still work, but proactive WhatsApp messaging will not be production-ready.

## Post-Deploy Checks

After Railway variables are added:

1. Open `https://vaitalcare-production.up.railway.app`
2. Confirm n8n login works
3. Confirm WF11, WF12, WF6, WF7, WF8, and WF9 are active
4. Register Twilio inbound webhook:
   `https://vaitalcare-production.up.railway.app/webhook/feedback-listener`
5. Register Twilio status callback:
   `https://vaitalcare-production.up.railway.app/webhook/twilio-status-callback`
6. Submit one patient form and one hospital form test entry
