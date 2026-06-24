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
TWILIO_CONTENT_FOLLOWUP_CONFIRMATION=
TWILIO_CONTENT_SAME_DAY_REMINDER=
TWILIO_CONTENT_MISSED_RECOVERY=
TWILIO_CONTENT_MISSED_NUDGE=
TWILIO_CONTENT_HEALTH_CHECK=
TWILIO_CONTENT_REACTIVATION=
TWILIO_CONTENT_MEDICINE_MORNING_DOSE=
TWILIO_CONTENT_MEDICINE_AFTERNOON_DOSE=
TWILIO_CONTENT_MEDICINE_EVENING_DOSE=
TWILIO_CONTENT_MEDICINE_COURSE_COMPLETE=
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
- In production, set `TWILIO_VALIDATE_WEBHOOK_SIGNATURE=true` after confirming `WEBHOOK_URL` exactly matches the public n8n base URL configured in Twilio. WF6 and WF9 then validate `X-Twilio-Signature` before processing inbound/status callbacks.

For production proactive messages, create and approve Twilio Content templates, then place their Content SIDs in `.env`.

## 5. Configure Forms

Update:

- `patient-form/index.html`
- `hospital-form/index.html`
- `doctor-dashboard/index.html`

Replace `YOUR_N8N_WEBHOOK_URL` with your public n8n URL. Deploy the static forms through Vercel, Netlify, or another HTTPS static host.

For the doctor dashboard, also replace `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `PRESCRIPTION_DELIVERY_FUNCTION`. Doctors should use the deployed `doctor-dashboard/` URL and sign in with the dashboard username and password created during hospital onboarding.

The dashboard resolves doctors in this order: existing `doctor_profiles.user_id`, then latest matching `hospital_boarding.auth_user_id`. If it uses hospital onboarding, it creates the `doctor_profiles` row automatically after the password session is verified. You can still pre-create `doctor_profiles` rows manually; include the doctor details and set `user_id` to the Supabase Auth user UUID.

Prescription PDFs can also use these optional `doctor_profiles` fields: `qualification`, `clinic_address`, `clinic_city`, `clinic_phone`, `clinic_email`, `clinic_website`, `clinic_logo_url`, `doctor_phone`, `signature_image_url`, `signature_label`, and `stamp_label`. The hospital intake form captures matching optional fields in `hospital_boarding`; if the profile is missing them, the dashboard falls back to the latest matching hospital/doctor onboarding row.

Prescription WhatsApp delivery is protected by a Supabase Edge Function gateway. Deploy `supabase/functions/prescription-delivery`, set `N8N_PRESCRIPTION_DELIVERY_URL`, `INTERNAL_WEBHOOK_SECRET`, and `DOCTOR_DASHBOARD_ORIGIN` as function secrets, and set the same `INTERNAL_WEBHOOK_SECRET` in n8n. WF13 rejects unsigned or stale requests.

WF11 matches incoming visit rows to `doctor_profiles` by lowercased clinic and doctor name. If no profile exists yet, the visit still appears once a matching profile is created because the RLS policy also allows clinic/doctor-name matching.

Each issued prescription stores immutable `doctor_snapshot` and `clinic_snapshot` JSON on the `prescriptions` row, plus `pdf_storage_path` in the private Supabase Storage bucket. The dashboard opens PDFs from storage by generating a fresh signed URL, so patient/profile history can still find the prescription after an older signed link expires.

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
