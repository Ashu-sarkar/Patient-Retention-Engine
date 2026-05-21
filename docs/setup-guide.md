# Twilio-Only Setup Guide

This project uses n8n, Supabase, and Twilio WhatsApp. Google Sheets and legacy direct-provider WhatsApp setup are not part of the current setup.

## 1. Configure Environment

Copy `.env.example` to `.env` and fill in:

```bash
N8N_ENCRYPTION_KEY=
N8N_OWNER_EMAIL=
N8N_OWNER_PASSWORD=
WEBHOOK_URL=https://your-n8n-domain.example

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_DB_HOST=
SUPABASE_DB_PORT=5432
SUPABASE_DB_NAME=postgres
SUPABASE_DB_USER=
SUPABASE_DB_PASSWORD=

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
TWILIO_STATUS_CALLBACK_URL=https://your-n8n-domain.example/webhook/twilio-status-callback

TWILIO_CONTENT_WELCOME=
TWILIO_CONTENT_FOLLOW_UP_REMINDER=
TWILIO_CONTENT_SAME_DAY_REMINDER=
TWILIO_CONTENT_MISSED_RECOVERY=
TWILIO_CONTENT_MISSED_NUDGE=
TWILIO_CONTENT_HEALTH_CHECK=
TWILIO_CONTENT_REACTIVATION=
```

Run:

```bash
npm run validate-env
```

The validator intentionally fails if old direct-provider variables are present.

## 2. Prepare Supabase

Use the Supabase session pooler credentials in `.env`, then run:

```bash
npm run preflight
```

This creates or aligns:

- `patients`
- `doctor_profiles`
- `patient_visits`
- `prescriptions`
- `prescription_medicines`
- `prescription_audit_logs`
- `message_logs`
- `message_ledger`
- `system_logs`
- `hospital_boarding`

## 3. Start n8n

```bash
./launch.sh
```

The launcher starts Docker, imports workflows, creates Supabase and Twilio credentials, and activates workflows.

For manual setup, create these n8n credentials:

- `Supabase (Postgres)` using Supabase pooler credentials
- `Twilio Basic Auth` with username `TWILIO_ACCOUNT_SID` and password `TWILIO_AUTH_TOKEN`

## 4. Configure Twilio

In Twilio Console:

- Set inbound WhatsApp webhook to:
  `https://your-n8n-domain.example/webhook/feedback-listener`
- Set status callback webhook to:
  `https://your-n8n-domain.example/webhook/twilio-status-callback`
- Use HTTP `POST`.

For production proactive messages, create and approve Twilio Content templates, then place their Content SIDs in `.env`.

## 5. Configure Forms

Update:

- `patient-form/index.html`
- `hospital-form/index.html`
- `doctor-dashboard/index.html`

Replace `YOUR_N8N_WEBHOOK_URL` with your public n8n URL. Deploy the static forms through Vercel, Netlify, or another HTTPS static host.

For the doctor dashboard, also replace `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `PRESCRIPTION_WEBHOOK_URL`. Create one Supabase Auth user per doctor, then insert a matching `doctor_profiles` row with `user_id`, `doctor_name`, `clinic_name`, and `registration_number`.

WF11 matches incoming visit rows to `doctor_profiles` by lowercased clinic and doctor name. If no profile exists yet, the visit still appears once a matching profile is created because the RLS policy also allows clinic/doctor-name matching.

## 6. Test

```bash
npm run setup
npm test
```

The tests validate workflow imports, webhook behavior, Supabase writes, Twilio-shaped inbound replies, delivery status callbacks, and the new queue/prescription tables when configured.

## Troubleshooting

- **Messages fail:** verify `Twilio Basic Auth`, `TWILIO_WHATSAPP_FROM`, and Content SIDs.
- **Inbound replies do not arrive:** confirm Twilio sender or Messaging Service inbound webhook points to `/webhook/feedback-listener`.
- **Delivery status does not update:** confirm `StatusCallback` is set or `TWILIO_STATUS_CALLBACK_URL` is passed by the workflows.
- **Duplicate sends:** scheduled workflows exclude message logs for the same patient, message type, and scheduled date.
