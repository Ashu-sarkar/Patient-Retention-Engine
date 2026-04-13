# System Architecture

Detailed technical architecture of the Patient Retention Engine.

---

## Mental Model

Every interaction follows this loop:

```
Event → Decision → Action → Feedback → Update
```

| Stage | Example |
|-------|---------|
| **Event** | Patient's follow-up date is tomorrow |
| **Decision** | Patient is `pending`, `message_count < 3`, last message > 23h ago |
| **Action** | Send WhatsApp reminder |
| **Feedback** | Patient replies "Yes, I'll be there" |
| **Update** | `response_status = confirmed` |

---

## System Layers

### Layer 1: Input Layer

How patient data enters the system.

**Manual Entry (Phase 1):**
- Clinic staff adds a new row to the `Patients` sheet in Google Sheets
- Workflow 7 detects the new row (polls every minute) and initialises the record

**Google Forms (Phase 2+):**
- Patient or staff submits a Google Form
- Form response is automatically written to the Patients sheet
- Workflow 7 picks it up immediately

**WhatsApp Replies:**
- Patient sends a WhatsApp message in response to a system message
- Twilio/Meta calls the Workflow 6 webhook
- Workflow 6 classifies and stores the response

---

### Layer 2: Database Layer (Google Sheets)

Three-sheet structure:

```
┌─────────────────────────────────────────┐
│           Patients (Sheet 1)            │
│  Source of truth for patient lifecycle  │
│  One row per patient                    │
└────────────────┬────────────────────────┘
                 │ read/write
┌────────────────▼────────────────────────┐
│         Message_Logs (Sheet 2)          │
│  Append-only log of every message sent  │
│  Never modified after write             │
└────────────────┬────────────────────────┘
                 │ append
┌────────────────▼────────────────────────┐
│          System_Logs (Sheet 3)          │
│  Operational events: INFO, WARN, ERROR  │
│  Never modified after write             │
└─────────────────────────────────────────┘
```

**Read pattern:** Workflows read ALL rows from the Patients sheet, then filter in n8n Code nodes. This avoids Google Sheets formula complexity and keeps all logic in the orchestration layer.

**Write pattern:** Updates to patient records use `id` as the matching key. Logs are always appended (never updated).

---

### Layer 3: Trigger Engine

All triggers are managed by n8n. Two types:

**Time-based triggers (Schedule nodes):**
| Workflow | Cron | n8n Node |
|----------|------|----------|
| Workflow 1 — Follow-Up Reminder | Daily 9:00 AM | `scheduleTrigger` |
| Workflow 2 — Same-Day Reminder | Daily 8:00 AM | `scheduleTrigger` |
| Workflow 3 — Missed Recovery | Daily 10:00 AM | `scheduleTrigger` |
| Workflow 4 — Health Check | Daily 10:15 AM | `scheduleTrigger` |
| Workflow 5 — Reactivation | Weekly Mon 9:00 AM | `scheduleTrigger` |

**Event-based triggers:**
| Workflow | Trigger | n8n Node |
|----------|---------|----------|
| Workflow 6 — Feedback Listener | POST to webhook URL | `webhook` |
| Workflow 7 — New Patient | New row in Patients sheet | `googleSheetsTrigger` |
| Workflow 8 — Error Handler | Any workflow fails | `errorTrigger` |

---

### Layer 4: Decision Engine

All decision logic lives in **n8n Code nodes** (JavaScript). No logic is stored in Google Sheets formulas.

**Decision rules per workflow:**

**Workflow 1 — Follow-Up Reminder:**
```
follow_up_date == tomorrow
AND status == 'pending'
AND message_count < MAX_MESSAGE_COUNT
AND hours_since_last_message > 23
AND phone is valid E.164 format
```

**Workflow 2 — Same-Day Reminder:**
```
follow_up_date == today
AND status == 'pending'
AND message_count < MAX_MESSAGE_COUNT
AND hours_since_last_message > 23
```

**Workflow 3 — Missed Recovery:**
```
follow_up_date < today
AND status NOT IN ('completed', 'inactive')
AND days_overdue IN (1, 3)   → send message
AND days_overdue >= 7        → set status = 'missed', stop messaging
```

**Workflow 4 — Health Check:**
```
visit_date == 2 or 3 days ago
AND health_check_sent == FALSE
AND status NOT IN ('inactive')
```

**Workflow 5 — Reactivation:**
```
last_message_sent > 30 days ago (or never sent)
AND reactivation_sent == FALSE
AND status NOT IN ('inactive', 'completed')
```

**Workflow 6 — Feedback Listener:**
```
Incoming message FROM phone_number
→ find patient by phone
→ classify message:
    contains 'yes|confirm|will come|ok'   → 'confirmed'
    contains 'cancel|reschedule|no'        → 'cancelled'
    else                                   → 'responded'
```

---

### Layer 5: Messaging Agent

All outbound messages go through a **Twilio HTTP Request node** (Phase 1–2) or **Meta Cloud API HTTP Request node** (Phase 3+).

**Twilio flow:**
```
n8n HTTP Request (POST)
  → api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
  → form-urlencoded body: To, From, Body
  → Basic Auth: Account SID + Auth Token
  ← Response: { sid, status, ... }
```

**Meta Cloud API flow:**
```
n8n HTTP Request (POST)
  → graph.facebook.com/v18.0/{PHONE_NUMBER_ID}/messages
  → JSON body: { to, type, template: { name, language, components } }
  → Bearer Token auth
  ← Response: { messages: [{ id }] }
```

**Rate limiting:** n8n processes items sequentially by default. For large patient lists, a `Wait` node (500ms) between sends prevents Twilio rate limit errors (1 msg/sec limit on sandbox).

**Retry logic:** Each HTTP Request node has **Retry on Fail** enabled (3 retries, 30s delay). After 3 failures, the error is caught by the Error Handler workflow.

---

### Layer 6: Feedback Listener

Workflow 6 runs permanently (webhook trigger, always active).

**Processing flow:**
```
Inbound POST (Twilio or Meta)
       │
       ▼
   Extract phone + body
   (normalise phone to E.164 format)
       │
       ▼
   Read Patients sheet
   Find row where phone matches
       │
       ├── Found: classify message → update patient record
       │
       └── Not Found: log WARN "Unknown sender: {phone}"
       │
       ▼
   Respond 200 OK to Twilio/Meta
   (required within 15 seconds or Twilio retries)
       │
       ▼
   Append to System_Logs
```

---

### Layer 7: State Manager

Patient state transitions are controlled by workflows:

```
         ┌─────────────────┐
  Entry  │                 │  Staff marks completed
 ───────►│    pending      │─────────────────────────►  completed
         │                 │
         └────────┬────────┘
                  │
                  │ follow_up_date + 7 days passed
                  ▼
         ┌─────────────────┐
         │                 │
         │     missed      │
         │                 │
         └────────┬────────┘
                  │
                  │ 30+ days no activity
                  ▼
         ┌─────────────────┐
         │                 │
         │    inactive     │  ◄── final state, stops all messaging
         │                 │
         └─────────────────┘
```

State transition rules:
- `pending → completed`: Staff manually updates status after patient attends
- `pending → missed`: Automatic, 7 days after follow_up_date (Workflow 3)
- `missed/pending → inactive`: Automatic, 30 days of no engagement (Workflow 5 side-effect)
- `inactive → pending`: Manual by staff (e.g. patient books again)

---

### Layer 8: Logging Layer

**Message_Logs** captures every outbound message:
- Written immediately after each successful HTTP send
- Contains full message text for audit trail
- `delivery_status` starts as `sent`; can be updated to `delivered`/`read` via webhook callbacks (Phase 5)

**System_Logs** captures workflow execution events:
- `INFO`: Normal execution events (workflow ran, N patients processed)
- `WARN`: Skipped records (invalid phone, already messaged, no follow-up date)
- `ERROR`: Failures (API error, workflow crash, unhandled exception)

---

## Logical Agent Model

The system is logically divided into five agents, all implemented within n8n:

```
┌─────────────────────────────────────────────────────┐
│                    n8n Instance                     │
│                                                     │
│  ┌─────────────┐    ┌────────────────┐              │
│  │  Scheduler  │───►│    Decision    │              │
│  │   Agent     │    │     Agent      │              │
│  │  (WF 1-5)  │    │  (Code nodes)  │              │
│  └─────────────┘    └───────┬────────┘              │
│                             │                       │
│                    ┌────────▼────────┐              │
│                    │   Messaging     │              │
│                    │     Agent       │              │
│                    │  (HTTP Request) │              │
│                    └────────┬────────┘              │
│                             │                       │
│  ┌─────────────┐    ┌───────▼────────┐              │
│  │   Tracker   │◄───│    Listener    │              │
│  │    Agent    │    │     Agent      │              │
│  │   (WF 7-8) │    │    (WF 6)      │              │
│  └─────────────┘    └────────────────┘              │
│                                                     │
└─────────────────────────────────────────────────────┘
```

| Agent | Workflows | Responsibility |
|-------|-----------|----------------|
| Scheduler | WF 1–5 | Trigger time-based and event-based workflows |
| Decision | Code nodes in WF 1–5 | Filter patients, determine who/when/what to message |
| Messaging | HTTP Request nodes | Send WhatsApp messages via Twilio or Meta |
| Listener | WF 6 | Receive and classify inbound patient replies |
| Tracker | WF 7, 8 | Validate new entries, update state, log errors |

---

## Data Flow Diagram

```
Staff enters patient
        │
        ▼
  Google Sheets
  (Patients row)
        │
        ├─── Workflow 7 detects new row
        │         │
        │         ▼
        │    Validate → Generate ID → Welcome WhatsApp
        │
        ├─── Workflow 1/2 (daily cron)
        │         │
        │         ▼
        │    Filter relevant patients → Send reminder
        │         │
        │         ▼
        │    Update Patients sheet
        │    Append to Message_Logs
        │
        ├─── Workflow 3/4/5 (daily/weekly cron)
        │         │
        │         ▼
        │    Filter missed/inactive → Send recovery/health/reactivation
        │         │
        │         ▼
        │    Update Patients sheet + Message_Logs
        │
        └─── Patient replies via WhatsApp
                  │
                  ▼
            Twilio/Meta webhook → Workflow 6
                  │
                  ▼
            Classify → Update response_status
            Append to System_Logs
```

---

## Idempotency Strategy

Duplicate messages are prevented by checking two conditions in every workflow's decision node:

1. `message_count < MAX_MESSAGE_COUNT` (default: 5 per patient lifecycle)
2. `hours_since_last_message > 23` — prevents same workflow re-sending within a 23-hour window

This means if a cron job fires twice in quick succession (n8n restart, manual trigger), the second run will skip patients already messaged in the last 23 hours.

---

## Timezone Handling

All date comparisons use the `TIMEZONE` environment variable. The Code nodes normalise all date values using:

```javascript
const tz = $env.TIMEZONE || 'Asia/Kolkata';
// Dates are compared in local timezone
const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
// en-CA locale gives YYYY-MM-DD format
```

This ensures that a patient with `follow_up_date = 2024-01-22` gets messaged on January 22nd in the clinic's local timezone, not UTC.

---

## Extensibility Notes

### Migrating from Google Sheets to Postgres

1. Replace `n8n-nodes-base.googleSheets` nodes with `n8n-nodes-base.postgres` nodes
2. Keep all Code node logic identical
3. Add `INDEX` on `follow_up_date`, `status`, `phone` for query performance
4. All column names already match SQL snake_case conventions

### Adding a Second Clinic

Add a `clinic_id` column to the Patients sheet and filter by it in each workflow. Each clinic gets its own set of activated workflows (or use a single set with clinic-specific credentials).

### Adding SMS Fallback

If WhatsApp fails after 3 retries, add a fallback branch to the error handler that sends via Twilio SMS (same API, different `To` format — no `whatsapp:` prefix).

### Phase 5: OpenAI Integration

Replace static message bodies in HTTP Request nodes with a Code node that calls `openai.chat.completions.create()` with patient context. The response becomes the message body sent to Twilio/Meta.
