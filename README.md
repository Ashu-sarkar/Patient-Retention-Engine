# Patient Retention Engine

An event-driven automation system for clinic patient follow-ups using **n8n**, **Supabase/PostgreSQL**, and **Twilio WhatsApp**.

## What It Does

- Captures patient registrations from a QR form
- Stores patients, message logs, delivery state, and operational logs in Supabase
- Sends WhatsApp welcome, follow-up, missed appointment, health check, and reactivation messages through Twilio
- Handles inbound WhatsApp replies from Twilio webhooks
- Tracks Twilio delivery/read/failure callbacks
- Logs workflow errors and can alert an admin on WhatsApp

## Architecture

```text
Patient / staff QR form
        |
        v
WF11 Form Intake webhook
        |
        v
Supabase patients, message_logs, message_ledger, system_logs
        |
        +--> WF7 Welcome message
        +--> WF1-WF5 Scheduled reminders
        +--> WF6 Inbound Twilio replies
        +--> WF9 Twilio delivery callbacks
        +--> WF8 Error handler
        |
        v
Twilio Programmable Messaging for WhatsApp
```

Supabase is the source of truth. Twilio is the only WhatsApp provider in this setup.

## Repository Structure

```text
workflows/                 n8n workflow exports
schemas/                   Supabase schema and idempotent preflight migration
scripts/                   environment and database validation utilities
tests/                     n8n setup and integration tests
patient-form/              static QR patient intake form
hospital-form/             static hospital/clinic onboarding form
message-templates/         Twilio template metadata
docs/                      architecture and setup notes
```

## Required Credentials

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`, for example `whatsapp:+14155238886`
- `TWILIO_STATUS_CALLBACK_URL`, usually `${WEBHOOK_URL}/webhook/twilio-status-callback`
- Twilio Content SIDs for proactive templates:
  - `TWILIO_CONTENT_WELCOME`
  - `TWILIO_CONTENT_FOLLOW_UP_REMINDER`
  - `TWILIO_CONTENT_SAME_DAY_REMINDER`
  - `TWILIO_CONTENT_MISSED_RECOVERY`
  - `TWILIO_CONTENT_MISSED_NUDGE`
  - `TWILIO_CONTENT_HEALTH_CHECK`
  - `TWILIO_CONTENT_REACTIVATION`
- Supabase URL, service role key, and Postgres pooler credentials
- n8n owner credentials and a stable `N8N_ENCRYPTION_KEY`

## Local Start

```bash
cp .env.example .env
npm install
npm run validate-env
./launch.sh
```

`./launch.sh` runs the Supabase preflight migration, starts n8n, creates credentials, imports workflows, and activates them.

## Production Notes

- Use a public HTTPS `WEBHOOK_URL`.
- Register Twilio inbound WhatsApp replies to `/webhook/feedback-listener`.
- Register Twilio status callbacks to `/webhook/twilio-status-callback`.
- Use approved Twilio Content templates for proactive WhatsApp messages outside the 24-hour customer service window.
- Keep `N8N_ENCRYPTION_KEY` stable forever after first launch.
- Do not keep Legacy direct-provider variables in `.env`; `npm run validate-env` fails if they are present.

## Validation

```bash
npm run validate-env
npm run preflight
npm run setup
npm test
```

The integration tests cover form intake, hospital onboarding, inbound Twilio replies, Twilio status callbacks, workflow imports, and Supabase table access.
