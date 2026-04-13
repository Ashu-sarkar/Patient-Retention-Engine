# Patient Retention Engine

An event-driven, low-cost automation system that increases patient follow-up visits for clinics through timely, personalised WhatsApp communication.

Built on **n8n** (orchestration), **Google Sheets** (database), and **WhatsApp Business API** (messaging).

---

## What This System Does

- Sends follow-up appointment reminders the day before and on the day of the visit
- Recovers missed appointments with escalating recovery messages
- Checks on patients 2–3 days after their visit
- Reactivates patients who have gone quiet for 30+ days
- Listens for patient replies and updates records automatically
- Logs everything — messages, errors, and system events

---

## Architecture at a Glance

```
Google Forms / Manual Entry
         │
         ▼
  Patients Sheet (Google Sheets)
         │
    ┌────┴────┐
    │  n8n    │  ← 8 automated workflows
    └────┬────┘
         │
   WhatsApp Business API (Twilio / Meta)
         │
         ▼
   Patient Replies (Webhook → n8n)
         │
         ▼
   Message Logs + System Logs (Google Sheets)
```

---

## Repository Structure

```
Patient-Retention-Engine/
├── README.md                          ← You are here
├── .env.example                       ← Environment variable template
│
├── docs/
│   ├── architecture.md                ← Full system architecture
│   ├── setup-guide.md                 ← Step-by-step deployment guide
│   └── message-templates.md          ← WhatsApp template approval guide
│
├── schemas/
│   └── google-sheets-schema.md       ← Google Sheets column definitions
│
├── n8n-workflows/
│   ├── workflow-1-followup-reminder.json    ← Day-before reminder
│   ├── workflow-2-sameday-reminder.json     ← Same-day reminder
│   ├── workflow-3-missed-appointment.json   ← Missed visit recovery
│   ├── workflow-4-health-check.json         ← Post-visit health check
│   ├── workflow-5-reactivation.json         ← 30-day reactivation
│   ├── workflow-6-feedback-listener.json    ← Inbound reply handler
│   ├── workflow-7-new-patient.json          ← New patient onboarding
│   └── workflow-8-error-handler.json        ← Global error handler
│
├── message-templates/
│   └── templates.json                ← All WhatsApp message templates
│
└── scripts/
    └── validate-patient-data.js      ← Data validation CLI utility
```

---

## Quick Start

1. **Read the full setup guide**: [docs/setup-guide.md](docs/setup-guide.md)
2. **Copy environment variables**: `cp .env.example .env` and fill in your credentials
3. **Set up Google Sheets**: Follow [schemas/google-sheets-schema.md](schemas/google-sheets-schema.md)
4. **Deploy n8n**: Use Docker (self-hosted) or n8n.cloud
5. **Import workflows**: Upload each JSON from `n8n-workflows/` via n8n → Import
6. **Configure credentials** in n8n (Google Sheets, Twilio/Meta)
7. **Activate workflows** and test with a sample patient row

---

## Phase Rollout

| Phase | Timeline | Scope |
|-------|----------|-------|
| Phase 1 | Week 1 | n8n setup, Google Sheets, Twilio sandbox, Workflow 7 |
| Phase 2 | Week 2 | Workflows 1 & 2 (follow-up reminders) |
| Phase 3 | Week 3 | Workflow 3 (missed appointment recovery) |
| Phase 4 | Week 4 | Workflows 4, 5, 6 (health check, reactivation, feedback) |
| Phase 5 | Month 2+ | Workflow 8, logging improvements, OpenAI message tuning |

---

## Key Workflows

| # | Workflow | Trigger | Action |
|---|----------|---------|--------|
| 1 | Follow-Up Reminder | Daily 9 AM | Remind patients with follow-up tomorrow |
| 2 | Same-Day Reminder | Daily 8 AM | Remind patients with follow-up today |
| 3 | Missed Appointment Recovery | Daily 10 AM | Recover missed appointments (Day +1, +3) |
| 4 | Health Check | Daily 10 AM | Check in 2–3 days after visit |
| 5 | Reactivation | Weekly Monday 9 AM | Re-engage patients inactive 30+ days |
| 6 | Feedback Listener | Webhook (always on) | Capture and classify patient replies |
| 7 | New Patient Entry | New row in Sheets | Validate, initialise, send welcome message |
| 8 | Error Handler | Any workflow failure | Log error, alert admin |

---

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Orchestration | n8n (self-hosted or cloud) |
| Database | Google Sheets (extensible to Airtable / Postgres) |
| Messaging | WhatsApp via Twilio (Phase 1–2) / Meta Cloud API (Phase 3+) |
| Backend logic | JavaScript (n8n Code nodes) |
| AI (Phase 5) | OpenAI API |
| Forms | Google Forms / WhatsApp interactive replies |

---

## Cost Estimate (Monthly)

| Service | Estimated Cost |
|---------|---------------|
| n8n self-hosted (Railway/Render) | ~$5–10/month |
| Twilio WhatsApp messages | ~$0.005–0.015 per message |
| Google Sheets | Free |
| Meta Cloud API | Free (first 1000 conversations/month) |

For a clinic sending 500 messages/month: **~$12–20/month total**.

---

## Documentation

- [Architecture](docs/architecture.md) — System design, agent model, data flow
- [Setup Guide](docs/setup-guide.md) — Complete deployment instructions
- [Message Templates](docs/message-templates.md) — Template texts and Meta approval process
- [Google Sheets Schema](schemas/google-sheets-schema.md) — Database structure

---

## Notes for Clinic Staff

- Patient phone numbers must include the country code (e.g. `+919876543210`)
- Set `visit_date` and `follow_up_date` in `YYYY-MM-DD` format
- Mark `status` as `completed` when a patient attends their follow-up
- The system will automatically stop messaging patients marked as `inactive` or `completed`
