# System Architecture

## Mental Model

```text
Event -> Decision -> Action -> Feedback -> Update
```

The current production target is **n8n + Supabase + Twilio WhatsApp**.

## Data Flow

```text
QR form submission
  -> WF11 Form Intake
  -> Supabase patients + patient_visits
  -> Doctor dashboard queue
  -> prescription PDF issue + WF13 delivery
  -> WF7 Welcome / WF1-WF5 scheduled messages
  -> Twilio WhatsApp Messages API
  -> WF6 inbound reply webhook
  -> WF9 delivery status callback
  -> Supabase state + logs
```

## Layers

- **Input:** `patient-form/index.html` and `hospital-form/index.html` are static forms that POST to n8n webhooks.
- **Doctor app:** `doctor-dashboard/index.html` is a Supabase Auth dashboard for queue review, prescription drafting, PDF issue, and delivery handoff. Doctors authenticate with WhatsApp OTP using the registered onboarding phone; Supabase RLS scopes data to the claimed doctor profile.
- **Orchestration:** n8n workflows implement validation, scheduling, messaging, reply handling, status callbacks, and error handling.
- **Database:** Supabase PostgreSQL stores patients, visit queue rows, doctor profiles, prescriptions, medicines, message logs, idempotency ledger, hospital boarding, and system logs.
- **Messaging:** Twilio Programmable Messaging sends and receives WhatsApp messages.
- **Observability:** `message_logs`, `message_ledger`, and `system_logs` capture send attempts, delivery state, and operational events.

## Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| WF1 | Daily 9:00 | Follow-up reminder for tomorrow |
| WF2 | Daily 8:00 | Same-day appointment reminder |
| WF3 | Daily 10:00 | Missed appointment recovery and missed marking |
| WF4 | Daily 10:15 | Post-visit health check |
| WF5 | Monday 9:00 | 30-day reactivation |
| WF6 | Twilio inbound webhook | Patient reply classification |
| WF7 | Internal webhook | New patient welcome |
| WF8 | n8n error trigger | Error logging and admin alert |
| WF9 | Twilio status callback | Delivery/read/failure tracking |
| WF11 | Form webhook | Patient intake |
| WF12 | Form webhook | Hospital/clinic onboarding |
| WF13 | Form webhook | Prescription PDF WhatsApp delivery |

## Doctor Dashboard Flow

```text
Patient QR form
  -> WF11 validates identity + visit routing
  -> public.patients upsert by normalized WhatsApp phone
  -> public.patient_visits insert, visit_status = waiting
  -> Doctor Dashboard reads assigned visits via Supabase Auth + RLS
  -> Doctor Dashboard updates optional visit clinical context
  -> Previous visits and prescriptions remain linked by patient_id
  -> Doctor saves prescription draft
  -> Doctor issues PDF to Supabase Storage
  -> WF13 sends PDF link on WhatsApp and logs delivery state
```

## Twilio Contract

Outbound messages call:

```text
POST https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json
```

Authentication is HTTP Basic Auth using `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.

Proactive production messages use:

- `From`
- `To`
- `ContentSid`
- `ContentVariables`
- `StatusCallback`

Free-form session messages, such as WF6 auto-replies and WF8 admin alerts, use `Body`.

## Idempotency

Scheduled workflow reads exclude rows already present in `message_logs` for the same `patient_id`, `message_type`, and `scheduled_date`. Successful sends also write a matching row into `message_ledger`.

## Environment

Required WhatsApp variables:

```bash
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

Legacy direct-provider variables must not be present.
