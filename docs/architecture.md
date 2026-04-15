# System Architecture

Patient Retention Engine — Technical Architecture

---

## Mental Model

Every interaction follows this loop:

```
Event → Decision → Action → Feedback → Update
```

| Stage | Example |
|-------|---------|
| **Event** | Patient added to today's intake sheet |
| **Decision** | Is the row valid? Does the phone already exist in Supabase? |
| **Action** | Upsert to Supabase, send welcome WhatsApp |
| **Feedback** | Patient replies "YES" to reminder |
| **Update** | `response_status = confirmed` in Supabase |

---

## Full Data Flow (New Architecture)

```
7:00 AM
  │
  ▼
WF9 — Daily Sheet Creator
  │  Creates a new Google Sheet: "Patient Intake - YYYY-MM-DD"
  │  Applies headers, dropdowns, validation, formatting via Sheets API
  │  Saves sheet ID to Supabase daily_intake_sheets
  │  Emails sheet link to clinic (Gmail)
  │
  ▼
Staff fills the sheet (columns B–J only)
  hospital_name, doctor_name, patient_name, dob, sex,
  phone_number, visit_date, follow_up_required, follow_up_date
  │
  ▼  (every 10 minutes throughout the day)
WF10 — Sheet Sync
  │  Reads rows where id column is empty (not yet synced)
  │  Validates each row:
  │    - Required fields present
  │    - phone_number = 10 digits exactly
  │    - visit_date not in future
  │    - dob in past (if provided)
  │    - follow_up_date required and > visit_date (if follow_up_required=Yes)
  │    - Duplicate phones within batch detected
  │  For VALID rows:
  │    - Generates PAT-XXXX code
  │    - Maps 13-column schema → Supabase patients columns
  │    - UPSERTS to Supabase patients (ON CONFLICT phone DO UPDATE)
  │    - Writes back id=PAT-XXXX, status=Pending, timestamps to sheet
  │    - Calls WF7 webhook → welcome WhatsApp
  │  For INVALID rows:
  │    - Writes id=INVALID (or DUPLICATE), status=data_error to sheet
  │    - Logs error to Supabase system_logs
  │
  ▼
Supabase public.patients ← SOURCE OF TRUTH
  │
  ├── WF1 (Daily 9AM)     — follow_up_date = tomorrow AND status=pending
  ├── WF2 (Daily 8AM)     — follow_up_date = today AND status=pending
  ├── WF3 (Daily 10AM)    — follow_up_date < today AND status≠completed/inactive
  ├── WF4 (Daily 10:15AM) — visit_date = 2-3 days ago AND health_check_sent=FALSE
  ├── WF5 (Monday 9AM)    — last_message_sent > 30 days ago AND reactivation_sent=FALSE
  ├── WF6 (Webhook)       — inbound WhatsApp → find patient by phone → classify → update
  └── WF8 (Error)         — any workflow fails → log to system_logs → admin alert
```

---

## System Layers

### Layer 1: Input Layer — Daily Intake Sheet

**Google Sheets role (NEW): Input form only**

A new spreadsheet is created every morning at 7 AM by WF9:

```
WF9 (7 AM)
  │
  ▼
Google Drive API → Create spreadsheet in GOOGLE_DRIVE_FOLDER_ID
  │
  ▼
Google Sheets API batchUpdate:
  - Set headers (row 1, dark blue, bold)
  - Freeze row 1
  - Data validation dropdowns (hospital, doctor, sex, follow_up_required, status)
  - Conditional formatting (status colours)
  - Column protection (id, status, created_at, updated_at)
  - Phone column → Plain Text format
  │
  ▼
Supabase INSERT → daily_intake_sheets (stores spreadsheet_id + url)
  │
  ▼
Gmail → Email sheet link to CLINIC_EMAIL
```

**Staff responsibilities:**
- Fill columns B–J (hospital, doctor, name, dob, sex, phone, visit date, follow-up info)
- Leave columns A, K, L, M blank (auto-filled by WF10)

---

### Layer 2: Database Layer — Supabase (Source of Truth)

```
┌────────────────────────────────────────────────────────┐
│                  public.patients                       │
│  One row per patient (unique on phone number)          │
│  Written by WF10 (intake), read by WF1–WF6             │
│  Also written by WF1–WF6 for state updates             │
└───────────────────────────┬────────────────────────────┘
                            │ read/write
┌───────────────────────────▼────────────────────────────┐
│               public.message_logs                      │
│  Append-only log of every WhatsApp message sent        │
│  Written by WF1–WF7; never modified after write        │
└───────────────────────────┬────────────────────────────┘
                            │ append
┌───────────────────────────▼────────────────────────────┐
│               public.system_logs                       │
│  Operational events: INFO, WARN, ERROR                 │
│  Written by all workflows; never modified after write  │
└───────────────────────────┬────────────────────────────┘
                            │ append
┌───────────────────────────▼────────────────────────────┐
│            public.daily_intake_sheets                  │
│  One row per calendar date                             │
│  Written by WF9 at 7 AM; read by WF10 every 10 min     │
└────────────────────────────────────────────────────────┘
```

**Why Supabase and NOT Google Sheets for state?**
- Google Sheets is single-threaded — concurrent writes from multiple workflows cause race conditions
- Supabase PostgreSQL supports atomic upserts, row-level security, and indexed queries
- All reminder workflows (WF1–WF5) can use efficient SQL WHERE clauses instead of loading all rows
- Audit trail is immutable and queryable

---

### Layer 3: Trigger Engine

**New workflows:**

| Workflow | Cron | Trigger | Purpose |
|----------|------|---------|---------|
| WF9 | `0 7 * * *` | Schedule | Create daily intake sheet |
| WF10 | `*/10 * * * *` | Schedule | Sync sheet rows → Supabase |

**Existing workflows (unchanged triggers, updated data source):**

| Workflow | Cron | Trigger | Data Source |
|----------|------|---------|-------------|
| WF1 Follow-Up Reminder | `0 9 * * *` | Schedule | Supabase SQL SELECT |
| WF2 Same-Day Reminder | `0 8 * * *` | Schedule | Supabase SQL SELECT |
| WF3 Missed Recovery | `0 10 * * *` | Schedule | Supabase SQL SELECT |
| WF4 Health Check | `15 10 * * *` | Schedule | Supabase SQL SELECT |
| WF5 Reactivation | `0 9 * * 1` | Schedule | Supabase SQL SELECT |
| WF6 Feedback Listener | Always on | Webhook | Supabase SQL SELECT by phone |
| WF7 New Patient Welcome | Always on | Webhook (called by WF10) | Payload from WF10 |
| WF8 Error Handler | Always on | Error trigger | n8n error payload |

---

### Layer 4: Decision Engine

All decision logic lives in **n8n Code nodes** (JavaScript). No logic in Google Sheets formulas.

**WF10 validation rules:**
```
phone_number:
  - 10 digits exactly (no country code, no spaces)
  - Unique within the batch
  - WF10 prepends +91 for E.164 format

visit_date:
  - Required
  - Must not be in the future

dob:
  - Optional
  - If provided, must be in the past

follow_up_required = 'Yes':
  - follow_up_date must be present
  - follow_up_date must be strictly after visit_date

follow_up_required = 'No':
  - follow_up_date must be empty (will be cleared if set)

Duplicate phone in batch:
  - First occurrence → synced normally
  - Second occurrence → flagged as DUPLICATE, not synced
```

**WF1 filter logic (Follow-Up Reminder):**
```
SQL: SELECT WHERE status='pending' AND follow_up_date >= CURRENT_DATE
Code node: follow_up_date == tomorrow (local TZ)
           AND message_count < MAX_MESSAGE_COUNT
           AND hours_since_last_message > 23
```

**WF3 action routing:**
```
days_overdue == 1  → send_recovery message
days_overdue == 3  → send_nudge message
days_overdue >= 7  → mark_missed (UPDATE status='missed', stop messaging)
```

---

### Layer 5: Messaging Agent

All outbound messages go through a **Twilio HTTP Request node**.

```
n8n HTTP Request (POST)
  → api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
  → form-urlencoded: To (whatsapp:+91...), From, Body
  → Basic Auth: Account SID + Auth Token
  ← Response: { sid, status, ... }
```

**Rate limiting:** n8n processes items sequentially. A `Wait` node can be added for large batches (1 msg/sec Twilio sandbox limit).

**Retry logic:** HTTP Request nodes have Retry on Fail (3 retries, 30s delay). Failures route to error log nodes.

---

### Layer 6: Feedback Listener (WF6)

WF6 runs permanently (webhook trigger, always active).

```
Inbound POST (Twilio or Meta)
       │
       ▼
   Extract phone + body → classify message
   (confirmed / cancelled / help / book / responded)
       │
       ▼
   Supabase SELECT WHERE phone = '...'
   (instead of reading all rows from Google Sheets)
       │
       ├── Found: UPDATE response_status, last_response
       │         → auto-reply if confirmed/cancelled/help
       │
       └── Not Found: log WARN "Unknown sender: {phone}"
       │
       ▼
   Respond 200 OK to Twilio (within 15 seconds)
       │
       ▼
   INSERT to system_logs
```

---

### Layer 7: State Manager

Patient state transitions remain identical (still controlled by Supabase updates):

```
         ┌─────────────────┐
  Entry  │                 │  Staff marks completed
 (WF10) ►│    pending      │──────────────────────────► completed
         │                 │
         └────────┬────────┘
                  │
                  │ follow_up_date + 7 days passed (WF3)
                  ▼
         ┌─────────────────┐
         │     missed      │
         └────────┬────────┘
                  │
                  │ 30+ days no activity (WF5 side-effect)
                  ▼
         ┌─────────────────┐
         │    inactive     │  ← final state, stops all messaging
         └─────────────────┘
```

Additional states:
- `data_error`: Set by WF10 when a row fails validation (written back to intake sheet too)

---

### Layer 8: Logging Layer

**Supabase `public.system_logs`** captures all operational events:
- `INFO`: Normal events (sheet created, patient synced, message sent)
- `WARN`: Skipped/invalid records (unknown sender, duplicate phone, data_error row)
- `ERROR`: Failures (API error, workflow crash, sheet creation failure)

**Supabase `public.message_logs`** captures every outbound message:
- Written immediately after each HTTP send
- Contains full message text for audit trail
- `delivery_status` starts as `sent`

**Supabase `public.daily_intake_sheets`** tracks each day's sheet:
- Queried by WF10 to know which sheet to poll
- Updated with `last_synced_at`, `rows_synced`, `rows_errored`

---

## Schema: 13-Column Daily Intake Sheet

| Col | Header | Who Fills | Required |
|-----|--------|-----------|----------|
| A | `id` | WF10 (PAT-XXXX) | Protected |
| B | `hospital_name` | Staff (dropdown) | Required |
| C | `doctor_name` | Staff (dropdown) | Required |
| D | `patient_name` | Staff | Required |
| E | `dob` | Staff (date) | Optional |
| F | `sex` | Staff (dropdown) | Optional |
| G | `phone_number` | Staff (10 digits) | Required |
| H | `visit_date` | Staff (date) | Required |
| I | `follow_up_required` | Staff (Yes/No) | Required |
| J | `follow_up_date` | Staff (date) | Conditional |
| K | `status` | WF10 (Pending) | Protected |
| L | `created_at` | WF10 (timestamp) | Protected |
| M | `updated_at` | WF10 (timestamp) | Protected |

**Field mapping to Supabase `patients`:**

| Intake Column | Supabase Column |
|---------------|-----------------|
| hospital_name | clinic_name |
| doctor_name | doctor_name |
| patient_name | name |
| dob | dob |
| sex | sex |
| phone_number | phone (as +91XXXXXXXXXX) |
| visit_date | visit_date |
| follow_up_required | follow_up_required |
| follow_up_date | follow_up_date |
| *(generated)* | patient_code (PAT-XXXX) |

---

## Idempotency Strategy

1. **WF10**: Processes only rows where `id` column is empty → prevents re-syncing
2. **WF1–WF5**: Check `hours_since_last_message > 23` → prevents double-sending if cron fires twice
3. **WF1–WF5**: Check `message_count < MAX_MESSAGE_COUNT` → prevents over-messaging
4. **Supabase upsert**: `ON CONFLICT (phone) DO UPDATE` → prevents duplicate patient records
5. **WF7**: Welcome message only fires when WF10 calls the webhook → one-time per sync

---

## Timezone Handling

All date comparisons use the `TIMEZONE` environment variable (default: `Asia/Kolkata`):

```javascript
const tz = $env.TIMEZONE || 'Asia/Kolkata';
const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
// en-CA locale gives YYYY-MM-DD format regardless of system locale
```

---

## New Environment Variables

```bash
# Google Drive folder where daily intake sheets are created
GOOGLE_DRIVE_FOLDER_ID=your_folder_id_here

# Dropdown values for the daily intake sheet
CLINIC_HOSPITAL_NAMES=City Hospital,General Hospital,Metro Clinic
CLINIC_DOCTOR_NAMES=Dr. Sharma,Dr. Mehta,Dr. Patel,Dr. Kumar

# Email address(es) to receive the daily sheet link
CLINIC_EMAIL=clinic@example.com

# WF7 webhook path (leave as default unless there's a conflict)
N8N_WF7_WEBHOOK_PATH=new-patient-intake
```

---

## New n8n Credentials Required

| Credential | Used By | Scope Needed |
|------------|---------|-------------|
| `googleDriveOAuth2Api` | WF9 | `https://www.googleapis.com/auth/drive` |
| `googleSheetsOAuth2Api` | WF9, WF10 | `https://www.googleapis.com/auth/spreadsheets` |
| `gmailOAuth2` | WF9 | `https://www.googleapis.com/auth/gmail.send` |
| `Supabase DB` (Postgres) | All workflows | Supabase service role key |
| `Twilio Basic Auth` | WF1–WF7 | Twilio Account SID + Auth Token |

**Note:** `googleDriveOAuth2Api` and `googleSheetsOAuth2Api` can be the same Google OAuth2 credential if configured with both scopes (drive + spreadsheets).

---

## Workflow Activation Order

Activate in this exact order to avoid dependency errors:

1. **WF8** (Error Handler) — must be live before others to catch errors
2. **WF7** (New Patient Welcome) — webhook must be live before WF10 calls it
3. **WF6** (Feedback Listener) — register webhook URL in Twilio/Meta
4. **WF9** (Daily Sheet Creator) — test by running manually once
5. **WF10** (Sheet Sync) — test by adding a row to today's sheet manually
6. **WF1–WF5** (Reminder workflows) — activate in any order

---

## Extensibility Notes

### Adding a Second Clinic
- Add `clinic_id` column to the `patients` table
- Add separate `CLINIC_HOSPITAL_NAMES_2` and `CLINIC_EMAIL_2` env vars
- Create a duplicate WF9 for the second clinic with its own folder ID and email
- WF10 can be parameterised or duplicated per clinic

### Changing Country Code
WF10 hardcodes `+91` (India) in the phone normalisation. To change:
```javascript
// In WF10 "Validate and Map Rows" Code node, line:
normPhone = '+91' + rawPhone;
// Change +91 to your country code, or make it configurable via env:
normPhone = ($env.CLINIC_COUNTRY_CODE || '+91') + rawPhone;
```

### Migrating to Multiple Countries
If the clinic serves international patients, consider storing phone numbers with full country code in the intake sheet (e.g., `+44XXXXXXXXXX`) and validating with E.164 format directly rather than auto-prepending.

### Phase 5: AI Message Personalisation
Replace static `_message_body` strings in Code nodes with an OpenAI API call:
```javascript
const response = await fetch('https://api.openai.com/v1/chat/completions', {
  headers: { Authorization: 'Bearer ' + $env.OPENAI_API_KEY },
  body: JSON.stringify({ model: 'gpt-4o-mini', messages: [...] })
});
```
