# Google Sheets Schema

This document defines the exact structure of all sheets in the Patient Retention Engine spreadsheet.

---

## Setup Instructions

1. Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet
2. Name it: **Patient Retention Engine**
3. Create 3 sheets (tabs) with the exact names below
4. Add column headers in Row 1 exactly as listed (case-sensitive)
5. Share the spreadsheet with your n8n service account email (Editor access)
6. Copy the Spreadsheet ID from the URL and set it as `GOOGLE_SHEETS_ID` in your `.env`

---

## Sheet 1: `Patients`

This is the primary patient record store. One row per patient.

### Column Headers (Row 1)

| Column | Header | Type | Description |
|--------|--------|------|-------------|
| A | `id` | Text | UUID, auto-generated on new patient entry (e.g. `a3f7b2c1-...`) |
| B | `name` | Text | Full name of the patient (e.g. `Priya Sharma`) |
| C | `phone` | Text | Phone with country code, no spaces (e.g. `+919876543210`) |
| D | `doctor_name` | Text | Treating doctor's name (e.g. `Dr. Mehta`) |
| E | `clinic_name` | Text | Clinic name (e.g. `HealthPlus Clinic`) |
| F | `visit_date` | Date | Date of actual visit — format `YYYY-MM-DD` (e.g. `2024-01-15`) |
| G | `follow_up_date` | Date | Scheduled follow-up date — format `YYYY-MM-DD` (e.g. `2024-01-22`) |
| H | `status` | Text | Patient lifecycle status. See values below. |
| I | `last_message_sent` | DateTime | ISO 8601 timestamp of last message sent (e.g. `2024-01-14T09:00:00.000Z`) |
| J | `message_count` | Number | Total messages sent to this patient (starts at 0) |
| K | `response_status` | Text | Patient reply status. See values below. |
| L | `last_response` | Text | Raw text of the patient's last WhatsApp reply |
| M | `health_check_sent` | Boolean | `TRUE` or `FALSE` — whether health check message was sent |
| N | `reactivation_sent` | Boolean | `TRUE` or `FALSE` — whether reactivation message was sent |
| O | `notes` | Text | Free-text notes for clinic staff (optional) |
| P | `created_at` | DateTime | ISO 8601 timestamp when record was created |
| Q | `updated_at` | DateTime | ISO 8601 timestamp of last record update |

### `status` Values

| Value | Meaning |
|-------|---------|
| `pending` | Follow-up is due; patient has not yet attended |
| `completed` | Patient attended their follow-up (set manually by staff) |
| `missed` | Follow-up date passed and patient did not attend (set automatically after 7 days) |
| `inactive` | Patient has not engaged in 30+ days |
| `data_error` | Record has invalid/missing required fields |

### `response_status` Values

| Value | Meaning |
|-------|---------|
| `none` | No reply received yet |
| `responded` | Patient replied but message is unclassified |
| `confirmed` | Patient confirmed they will attend / are attending |
| `cancelled` | Patient cancelled or asked to reschedule |

### Data Entry Notes

- **Phone numbers**: Always use E.164 format: `+[country_code][number]`, no spaces, no dashes
  - India: `+919876543210`
  - UAE: `+971501234567`
  - UK: `+447911123456`
- **Dates**: Always `YYYY-MM-DD` format. Use Google Sheets format: `Format → Number → Text` to prevent auto-conversion
- **Status**: Staff must manually set `status = completed` when patient attends follow-up
- **Leave blank** initially: `id`, `last_message_sent`, `message_count`, `response_status`, `last_response`, `health_check_sent`, `reactivation_sent`, `created_at`, `updated_at` — these are filled automatically by workflows

### Example Row

| id | name | phone | doctor_name | clinic_name | visit_date | follow_up_date | status | last_message_sent | message_count | response_status | last_response | health_check_sent | reactivation_sent | notes | created_at | updated_at |
|----|------|-------|-------------|-------------|------------|----------------|--------|-------------------|---------------|-----------------|---------------|-------------------|-------------------|-------|------------|------------|
| a3f7b2c1-4d5e-6f7a-8b9c-0d1e2f3a4b5c | Priya Sharma | +919876543210 | Dr. Mehta | HealthPlus Clinic | 2024-01-15 | 2024-01-22 | pending | | 0 | none | | FALSE | FALSE | | | |

---

## Sheet 2: `Message_Logs`

Immutable log of every message sent. New rows are appended; existing rows are never modified.

### Column Headers (Row 1)

| Column | Header | Type | Description |
|--------|--------|------|-------------|
| A | `log_id` | Text | UUID for this log entry |
| B | `patient_id` | Text | References `Patients.id` |
| C | `patient_name` | Text | Patient name at time of send (denormalised for readability) |
| D | `phone` | Text | Phone number messages was sent to |
| E | `workflow_name` | Text | Which workflow triggered the send (e.g. `workflow-1-followup-reminder`) |
| F | `message_type` | Text | Type of message (e.g. `follow_up_reminder`, `health_check`) |
| G | `message_sent` | Text | Full text of the message that was sent |
| H | `sent_at` | DateTime | ISO 8601 timestamp when the send was attempted |
| I | `delivery_status` | Text | `sent`, `failed`, `delivered`, `read` |
| J | `error_message` | Text | Error text if delivery failed (blank on success) |
| K | `twilio_sid` | Text | Twilio message SID (or Meta message ID) for tracking |

---

## Sheet 3: `System_Logs`

Operational log for all workflow executions, errors, and system events.

### Column Headers (Row 1)

| Column | Header | Type | Description |
|--------|--------|------|-------------|
| A | `log_id` | Text | UUID for this log entry |
| B | `timestamp` | DateTime | ISO 8601 timestamp of the event |
| C | `workflow_name` | Text | Name of the workflow (e.g. `workflow-3-missed-appointment`) |
| D | `execution_id` | Text | n8n execution ID for cross-referencing in n8n UI |
| E | `log_level` | Text | `INFO`, `WARN`, or `ERROR` |
| F | `message` | Text | Human-readable description of the event |
| G | `details` | Text | JSON string with additional context (patient_id, error stack, etc.) |

### `log_level` Values

| Level | When Used |
|-------|-----------|
| `INFO` | Normal operation — workflow ran, messages sent, records updated |
| `WARN` | Skipped record — missing phone, invalid data, message throttled |
| `ERROR` | Failure — API error, workflow crash, unrecoverable state |

---

## Google Sheets Formatting Tips

1. **Freeze Row 1** on all sheets: `View → Freeze → 1 row`
2. **Date columns** (F, G on Patients): Format as `Text` to prevent Google from converting date formats
3. **Phone column** (C on Patients): Format as `Plain text` (not number) to preserve leading `+`
4. **Boolean columns** (M, N on Patients): Use data validation → List of items: `TRUE,FALSE`
5. **Status column** (H on Patients): Use data validation → List: `pending,completed,missed,inactive,data_error`
6. **Add a Google Sheets filter** to the Patients sheet to allow staff to sort/filter by status

---

## Extending to Airtable or Postgres

The schema is designed to be portable. When migrating:

- **Airtable**: Each sheet becomes a table; field types map directly. Use Airtable's n8n node instead of Google Sheets node.
- **Postgres**: Use the exact column names as snake_case column names. Add `UNIQUE` constraint on `phone` and `INDEX` on `follow_up_date` and `status` for performance.

```sql
-- Postgres equivalent
CREATE TABLE patients (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  doctor_name TEXT,
  clinic_name TEXT,
  visit_date DATE,
  follow_up_date DATE,
  status TEXT DEFAULT 'pending',
  last_message_sent TIMESTAMPTZ,
  message_count INTEGER DEFAULT 0,
  response_status TEXT DEFAULT 'none',
  last_response TEXT,
  health_check_sent BOOLEAN DEFAULT FALSE,
  reactivation_sent BOOLEAN DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_patients_follow_up_date ON patients(follow_up_date);
CREATE INDEX idx_patients_status ON patients(status);
CREATE INDEX idx_patients_phone ON patients(phone);
```
