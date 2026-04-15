# System Architecture

Patient Retention Engine — Technical Reference

---

## Mental Model

```
Event → Decision → Action → Feedback → Update
```

| Stage | Example |
|-------|---------|
| **Event** | Patient scans QR code and submits the registration form |
| **Decision** | Is the payload valid? Does the phone already exist in Supabase? |
| **Action** | Upsert to Supabase, send welcome WhatsApp |
| **Feedback** | Patient replies "CONFIRM" to a follow-up reminder |
| **Update** | `response_status = confirmed` in Supabase |

---

## Full Data Flow

```
Patient scans QR code
        │
        ▼
patient-form/index.html  (HTML + CSS + Vanilla JS)
  │  Patient fills:   name, phone, dob, sex
  │  Staff fills:     hospital, doctor, visit_date, follow_up_required, [follow_up_date]
  │  Frontend validates before submit (10-digit phone, required fields, conditional date)
  │
  ▼  POST /webhook/patient-form-intake
WF11 — QR Form Intake
  │  Server-side re-validates all 9 fields (phone, dates, conditionals)
  │  Generates PAT-XXXX patient code (COUNT + 1)
  │  UPSERTS to public.patients (ON CONFLICT phone → update visit info, reset status)
  │  Calls WF7 webhook (fire-and-forget, continueOnFail=true)
  │  Logs to public.system_logs
  │  Responds 200 { status, patient_code } or 400 { errors[] }
  │
  ├──► WF7 — New Patient Welcome  (POST /webhook/new-patient-intake)
  │      Builds personalised welcome WhatsApp message
  │      Sends via Twilio
  │      Updates public.patients: last_message_sent, message_count=1
  │      Logs to public.message_logs
  │
  ▼
Supabase public.patients  ← SINGLE SOURCE OF TRUTH
  │
  ├── WF1  Daily 9:00 AM   — follow_up_date = tomorrow, status=pending → reminder
  ├── WF2  Daily 8:00 AM   — follow_up_date = today,    status=pending → same-day reminder
  ├── WF3  Daily 10:00 AM  — follow_up_date < today,    status≠completed → missed recovery
  ├── WF4  Daily 10:15 AM  — visit_date 2–3 days ago,   health_check_sent=FALSE → check-in
  ├── WF5  Monday 9:00 AM  — last_message > 30 days,    reactivation_sent=FALSE → reactivation
  ├── WF6  Webhook          — inbound WhatsApp → find patient by phone → classify → update
  └── WF8  Error trigger    — any workflow fails → log → admin WhatsApp alert
```

---

## System Layers

### Layer 1 — Input Layer (QR Form)

The sole data entry point is `patient-form/index.html`, served as a static file (Vercel / Netlify).

**UX design principles:**
- Mobile-first, 16 px inputs (no iOS zoom)
- Hospital → Doctor cascade dropdown
- Conditional follow-up date (shows only when follow_up_required = Yes)
- Single-page, < 20 second completion
- Pre-fill hospital via `?hospital=` URL param on QR code

**URL param on QR code:**
```
https://your-form.vercel.app/?hospital=City+Hospital
```
One QR code per clinic desk. The `hospital_name` dropdown is pre-selected; staff only choose the doctor and visit info.

---

### Layer 2 — Intake Webhook (WF11)

WF11 is the only workflow that writes new patient records.

**Node chain:**
```
Webhook — Form Intake
    → Validate and Normalise   (Code node, server-side rules)
    → Valid?                   (If node)
        ✓ → Get Patient Count  (Postgres: COUNT(*))
           → Assign Patient Code (Code: PAT-XXXX)
           → Upsert Patient    (Postgres: INSERT … ON CONFLICT phone DO UPDATE)
           → Call WF7 Welcome  (HTTP POST, continueOnFail=true)
           → Log Registration  (Postgres: system_logs INFO)
           → Respond 200 OK    { status: 'success', patient_code }
        ✗ → Log Validation Failure (Postgres: system_logs WARN)
           → Respond 400 Invalid  { status: 'error', errors[] }
```

**Validation rules enforced in WF11:**

| Field | Rule |
|-------|------|
| `patient_name` | Required, min 2 chars |
| `phone_number` | Required, exactly 10 digits (no +91) — normalised to E.164 (+91XXXXXXXXXX) |
| `hospital_name` | Required |
| `doctor_name` | Required |
| `visit_date` | Required, YYYY-MM-DD, not in the future |
| `follow_up_required` | Required, Yes or No |
| `follow_up_date` | Required + after `visit_date` **only when** follow_up_required = Yes |
| `sex` | Optional, must be Male / Female / Other if provided |
| `dob` | Optional, YYYY-MM-DD, must be a past date if provided |

**UPSERT conflict strategy:**

```sql
ON CONFLICT (phone) DO UPDATE SET
  name               = EXCLUDED.name,
  clinic_name        = EXCLUDED.clinic_name,
  doctor_name        = EXCLUDED.doctor_name,
  visit_date         = EXCLUDED.visit_date,
  follow_up_required = EXCLUDED.follow_up_required,
  follow_up_date     = EXCLUDED.follow_up_date,
  status             = 'pending',
  health_check_sent  = FALSE,
  reactivation_sent  = FALSE,
  updated_at         = NOW()
```

A returning patient's record is refreshed with the new visit. Reminders restart from scratch.

---

### Layer 3 — Database (Supabase / PostgreSQL)

```
┌────────────────────────────────────────────────────────┐
│                  public.patients                       │
│  One row per patient (unique on phone number)          │
│  Written by WF11; read and updated by WF1–WF7          │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│               public.message_logs                      │
│  Append-only log of every outbound WhatsApp message    │
│  Written by WF1–WF7; never modified after insert       │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│               public.system_logs                       │
│  Operational events: INFO, WARN, ERROR                 │
│  Written by all workflows; never modified after insert │
└────────────────────────────────────────────────────────┘
```

**Why Supabase, not a spreadsheet?**
- Atomic upserts → no race conditions from concurrent workflow runs
- Indexed SQL `WHERE` clauses → WF1–WF5 query only the rows they need
- Row Level Security → service-role key for n8n, anon blocked by default
- Immutable audit trail in `message_logs` and `system_logs`

---

### Layer 4 — Trigger Engine

| WF | Cron / Trigger | Purpose |
|----|----------------|---------|
| WF11 | Webhook POST `patient-form-intake` | New patient registration |
| WF7 | Webhook POST `new-patient-intake` | Welcome WhatsApp (called by WF11) |
| WF1 | `0 9 * * *` | Follow-up reminder — day before |
| WF2 | `0 8 * * *` | Follow-up reminder — same day |
| WF3 | `0 10 * * *` | Missed appointment recovery |
| WF4 | `15 10 * * *` | Post-visit health check-in |
| WF5 | `0 9 * * 1` | Monthly reactivation |
| WF6 | Always on (webhook) | Inbound WhatsApp feedback |
| WF8 | Always on (error trigger) | Global error handler |

---

### Layer 5 — Decision Engine

All decision logic lives in **n8n Code nodes** (JavaScript).

**WF1 filter logic (Follow-Up Reminder):**
```
SQL:  SELECT WHERE status='pending' AND follow_up_date >= CURRENT_DATE
Code: follow_up_date == tomorrow (local TZ)
      AND message_count < MAX_MESSAGE_COUNT
      AND hours_since_last_message >= MIN_HOURS_BETWEEN_MESSAGES
```

**WF3 action routing:**
```
days_overdue == 1  → send recovery message
days_overdue == 3  → send nudge message
days_overdue >= 7  → UPDATE status='missed' (stop all messaging)
```

**WF6 classification:**
```
Inbound text → toLowerCase → check keywords:
  'yes' / 'confirm'  → confirmed
  'no'  / 'cancel'   → cancelled
  'help'             → send help text
  anything else      → responded
```

---

### Layer 6 — Messaging Agent

All outbound messages use Twilio via an HTTP Request node:

```
POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(SID:TOKEN)

To=whatsapp:+91XXXXXXXXXX
From=whatsapp:+14155238886
Body=<message text>
```

**Retry:** 2 retries with 15 s delay (built into the HTTP Request node `options.retry`).  
**Rate limiting:** n8n processes items sequentially by default.

---

### Layer 7 — Feedback & State

WF6 listens permanently on a Twilio webhook:

```
Inbound POST (Twilio)
    │
    ▼ Extract phone + message body
    ▼ Supabase SELECT WHERE phone = ?
    ├── Found → classify → UPDATE response_status, last_response
    │                    → optional auto-reply (confirmed/cancelled/help)
    └── Not Found → log WARN
    ▼
Respond 200 OK to Twilio (within 15 seconds)
```

**Patient state machine:**
```
          ┌──────────────────────┐
  WF11   │                      │  Staff marks completed
 ──────► │      pending         │──────────────────────► completed
         │                      │
         └──────────┬───────────┘
                    │
                    │  follow_up_date + 7 days overdue (WF3)
                    ▼
         ┌──────────────────────┐
         │       missed         │
         └──────────┬───────────┘
                    │
                    │  30+ days no activity (WF5 side-effect)
                    ▼
         ┌──────────────────────┐
         │      inactive        │  ← final state, stops all messaging
         └──────────────────────┘
```

---

### Layer 8 — Logging

**`public.system_logs`** captures all operational events:
- `INFO` — Normal events (patient registered, message sent)
- `WARN` — Skipped records (unknown sender, validation failure)
- `ERROR` — Failures (API error, workflow crash)

**`public.message_logs`** captures every outbound message:
- Full message text for audit
- `delivery_status` starts as `sent`; update to `delivered`/`read` via Twilio status callbacks if needed

---

## Idempotency

| Scenario | Protection |
|----------|------------|
| Form submitted twice with same phone | `ON CONFLICT (phone) DO UPDATE` — updates the record, does not create duplicate |
| Cron fires twice in same minute | `hours_since_last_message >= MIN_HOURS_BETWEEN_MESSAGES` check in Code node |
| Over-messaging a patient | `message_count < MAX_MESSAGE_COUNT` check in all reminder Code nodes |
| WF7 welcome called but patient already messaged | `message_count` checked; WF7 always fires once per WF11 call |

---

## Environment Variables

```bash
# ── n8n Core ────────────────────────────────────────────────────
N8N_BASIC_AUTH_ACTIVE=true
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=strongpass
N8N_HOST=localhost
N8N_PORT=5678
WEBHOOK_URL=http://localhost:5678          # public HTTPS URL in production

# ── Supabase ────────────────────────────────────────────────────
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_DB_HOST=db.xxx.supabase.co
SUPABASE_DB_PORT=5432
SUPABASE_DB_NAME=postgres
SUPABASE_DB_USER=postgres
SUPABASE_DB_PASSWORD=...

# ── Twilio / WhatsApp ────────────────────────────────────────────
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886

# ── App Behaviour ───────────────────────────────────────────────
TIMEZONE=Asia/Kolkata
MAX_MESSAGE_COUNT=5
MIN_HOURS_BETWEEN_MESSAGES=23
DEFAULT_CLINIC_NAME=Our Clinic
DEFAULT_DOCTOR_NAME=Your Doctor
ADMIN_WHATSAPP_NUMBER=whatsapp:+919876543210
```

---

## n8n Credentials Required

| Credential Name | Type | Used By |
|-----------------|------|---------|
| `Supabase (Postgres)` | Postgres | WF1–WF8, WF11 |
| `Twilio Basic Auth` | HTTP Basic Auth | WF1–WF7 |

No Google credentials are needed.

---

## Workflow Activation Order

Activate in this exact sequence:

1. **WF8** — Error Handler (must be live first to catch all errors)
2. **WF7** — New Patient Welcome (webhook must exist before WF11 calls it)
3. **WF6** — Feedback Listener (register webhook URL in Twilio Sandbox settings)
4. **WF11** — QR Form Intake (test with a real form submission)
5. **WF1–WF5** — Reminder workflows (activate in any order)

---

## Timezone Handling

All date comparisons use `TIMEZONE` env var (default: `Asia/Kolkata`):

```javascript
const tz = $env.TIMEZONE || 'Asia/Kolkata';
const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
// en-CA locale returns YYYY-MM-DD regardless of system locale
```

---

## Extensibility

### Multiple clinics / desks
- Generate one QR code URL per clinic with `?hospital=City+Hospital`
- Optionally add a `?title=Wing+B` param for the header badge
- All submissions go to the same WF11 endpoint

### Change country code
WF11 hardcodes `+91`. To change:
```javascript
// In "Validate and Normalise" Code node:
const phone = '+91' + phoneRaw;
// Change to:
const phone = ($env.CLINIC_COUNTRY_CODE || '+91') + phoneRaw;
// Then add CLINIC_COUNTRY_CODE=+44 to .env
```

### AI-personalised messages
Replace static message strings in Code nodes with an OpenAI call:
```javascript
const res = await fetch('https://api.openai.com/v1/chat/completions', {
  headers: { Authorization: 'Bearer ' + $env.OPENAI_API_KEY },
  body: JSON.stringify({ model: 'gpt-4o-mini', messages: [...] })
});
```
