# Message Templates

All WhatsApp message templates used by the Patient Retention Engine.

---

## Overview

WhatsApp Business API has two types of messages:

1. **Session Messages** — Free-form messages sent within a 24-hour window after a patient last messaged you. No template approval needed.
2. **Template Messages** — Pre-approved messages sent outside the 24-hour window. All outbound proactive messages must use approved templates.

For **Twilio Sandbox** (development), pre-approval is not required — you can send any text. For **Meta Cloud API in production**, all proactive outbound messages must use approved templates.

---

## All Templates

### 1. Welcome Message

**Trigger:** New patient added to system
**Workflow:** `workflow-7-new-patient`
**Meta Template Name:** `patient_welcome`
**Category:** UTILITY

```
Hi {{name}}! 👋 Welcome to {{clinic_name}}. We've noted your visit with 
{{doctor_name}} and will keep you updated on your follow-up appointment. 
If you have any questions, feel free to reply to this message.
```

**Design notes:** Establishes the WhatsApp channel. The patient now knows messages will come from this number. First impressions matter — keep it warm.

---

### 2. Follow-Up Reminder (Day Before)

**Trigger:** `follow_up_date = tomorrow`
**Workflow:** `workflow-1-followup-reminder`
**Meta Template Name:** `patient_followup_reminder`
**Category:** UTILITY

```
Hi {{name}}, just a friendly reminder that your follow-up appointment with 
{{doctor_name}} at {{clinic_name}} is scheduled for *tomorrow*. We look 
forward to seeing you! 🏥

Reply *YES* to confirm or *RESCHEDULE* if you need to change the date.
```

**Design notes:** The call-to-action (`YES` / `RESCHEDULE`) feeds directly into the Feedback Listener (Workflow 6) to update `response_status`. The bold formatting (`*text*`) renders as bold in WhatsApp.

---

### 3. Same-Day Reminder

**Trigger:** `follow_up_date = today`
**Workflow:** `workflow-2-sameday-reminder`
**Meta Template Name:** `patient_sameday_reminder`
**Category:** UTILITY

```
Good morning {{name}}! 🌅 This is a reminder that your appointment with 
{{doctor_name}} is *today*. Please arrive on time and bring any documents 
or test reports from your previous visit.

See you soon at {{clinic_name}}!
```

**Design notes:** Practical and actionable. Mentioning documents reduces no-shows caused by "I didn't have my test reports". No CTA needed — just show up.

---

### 4. Missed Appointment Recovery (Day +1)

**Trigger:** `follow_up_date + 1 day`, `status != completed`
**Workflow:** `workflow-3-missed-appointment`
**Meta Template Name:** `patient_missed_recovery`
**Category:** UTILITY

```
Hi {{name}}, we noticed you missed your follow-up appointment with 
{{doctor_name}} yesterday. We completely understand that things come up! 😊

Your health is important to us. Would you like to reschedule? Reply 
*RESCHEDULE* and our team will get back to you shortly.
```

**Design notes:** Empathetic, never accusatory. The line "we completely understand" reduces the barrier to re-engagement. Offer a simple action (RESCHEDULE).

---

### 5. Missed Appointment Nudge (Day +3)

**Trigger:** `follow_up_date + 3 days`, `status != completed`
**Workflow:** `workflow-3-missed-appointment`
**Meta Template Name:** `patient_missed_nudge`
**Category:** UTILITY

```
Hi {{name}}, {{doctor_name}} wanted us to check in on you. It's been a 
few days since your scheduled follow-up at {{clinic_name}}.

Skipping follow-up care can sometimes delay recovery. If you'd like to 
book a new appointment, just reply *BOOK* and we'll arrange it for you. 💙
```

**Design notes:** Brings in the doctor's name to add clinical authority. The subtle health consequence mention ("delay recovery") motivates action without being alarmist.

---

### 6. Health Check (Post-Visit)

**Trigger:** `visit_date + 2-3 days`, `health_check_sent = false`
**Workflow:** `workflow-4-health-check`
**Meta Template Name:** `patient_health_check`
**Category:** UTILITY

```
Hi {{name}}! 😊 Hope you're feeling better after your visit with {{doctor_name}}.

How are you doing today? Reply with:
*GOOD* — feeling well
*OKAY* — some discomfort
*HELP* — need to speak with the doctor

We're here if you need anything!
```

**Design notes:** Structured response options make it easy for non-tech patients to reply. `HELP` can trigger a staff alert in Phase 5. This message alone generates significant goodwill — patients feel cared for.

---

### 7. Reactivation (30+ Days Inactive)

**Trigger:** `last_message_sent > 30 days`, `reactivation_sent = false`
**Workflow:** `workflow-5-reactivation`
**Meta Template Name:** `patient_reactivation`
**Category:** MARKETING

```
Hi {{name}}! 👋 It's been a while since we last saw you at {{clinic_name}}, 
and we just wanted to check in.

Regular health check-ups with {{doctor_name}} are the best way to stay 
ahead of any concerns. If you'd like to book an appointment, reply *BOOK* 
and our team will reach out.

Take care! 💙
```

**Design notes:** Non-pushy re-engagement. Frame around health benefit, not "we miss your business". Category is MARKETING for Meta — ensure you have appropriate opt-in.

---

### 8. Confirmed Auto-Reply

**Trigger:** Patient replies with confirmation keyword (`yes`, `confirm`, etc.)
**Workflow:** `workflow-6-feedback-listener`
**Session message** — no template needed

```
Thank you, {{name}}! ✅ We've noted that you'll be coming in for your 
appointment. See you then!

If anything changes, feel free to message us.
```

---

### 9. Reschedule Auto-Reply

**Trigger:** Patient replies with cancellation/reschedule keyword
**Workflow:** `workflow-6-feedback-listener`
**Session message** — no template needed

```
Hi {{name}}, no problem at all! 😊 We've noted that you'd like to 
reschedule. A member of our team will reach out to you shortly to 
arrange a new time.

Thank you for letting us know!
```

---

### 10. Admin Error Alert

**Trigger:** Any workflow failure
**Workflow:** `workflow-8-error-handler`
**Session message** — no template needed (admin-initiated)

```
⚠️ *Patient Retention Engine Alert*

Workflow: {{workflow_name}}
Error: {{error_message}}
Time: {{timestamp}}
Execution ID: {{execution_id}}

Please check the n8n dashboard and System_Logs sheet.
```

---

## Meta Template Submission Guide

### Before You Submit

1. Ensure all templates use double curly brace variables: `{{1}}`, `{{2}}` (Meta format)
   - In the JSON and n8n Code nodes we use `{{name}}` for readability
   - When submitting to Meta, convert to positional: `{{1}}` = name, `{{2}}` = doctor_name, `{{3}}` = clinic_name
2. Choose the correct **category** (UTILITY or MARKETING — see below)
3. Write a clear **template description** explaining when/why it's sent

### Category Selection

| Template | Category | Reason |
|----------|----------|--------|
| welcome | UTILITY | Transactional — confirms appointment |
| follow_up_reminder | UTILITY | Service-related notification |
| same_day_reminder | UTILITY | Service-related notification |
| missed_appointment_recovery | UTILITY | Service follow-up |
| missed_appointment_nudge | UTILITY | Service follow-up |
| health_check | UTILITY | Patient care notification |
| reactivation | MARKETING | Re-engagement — not tied to a recent interaction |

### Submission Steps

1. Go to [business.facebook.com](https://business.facebook.com)
2. Navigate to **WhatsApp Manager → Message Templates → Create Template**
3. Fill in:
   - **Category**: UTILITY or MARKETING
   - **Name**: use the `meta_template_name` value from `templates.json` (snake_case)
   - **Language**: English
   - **Header** (optional): text or image
   - **Body**: paste the template text, replace `{{name}}` with `{{1}}`, etc.
   - **Footer** (optional): clinic name or "Reply STOP to opt out"
   - **Buttons** (optional): Quick Reply buttons for YES/RESCHEDULE
4. Click **Submit for review**

### Approval Tips

- **DO**: Use natural, human language — avoid robotic phrasing
- **DO**: Reference a real service or appointment context
- **DO**: Keep templates under 1024 characters
- **DON'T**: Use templates for pure promotional content in UTILITY category
- **DON'T**: Include URLs unless they are genuine and verifiable
- **DON'T**: Use all-caps aggressively

### Adding Quick Reply Buttons (Recommended)

For `follow_up_reminder`, add two Quick Reply buttons:
- Button 1: `YES, I'll be there`
- Button 2: `Need to Reschedule`

These buttons send the button text as a reply, which Workflow 6 classifies automatically.

---

## Response Keyword Mapping

The Feedback Listener (Workflow 6) classifies responses using these keywords:

| Response | Keywords Detected |
|----------|------------------|
| `confirmed` | yes, confirm, confirmed, will come, coming, ok, okay, sure, yep, absolutely, see you |
| `cancelled` | no, cancel, cancelled, reschedule, can't make it, cannot come, not coming, postpone, change date |
| `book` | book, schedule, appointment, want to book, fix appointment |
| `help` | help, not well, pain, emergency, urgent, need doctor, call me |

Any reply not matching these keywords is stored as-is with `response_status = responded`. No action is taken — the raw text is available in `last_response` for staff to review.

---

## Messaging Frequency Rules

To prevent message fatigue and avoid WhatsApp spam detection:

| Rule | Limit |
|------|-------|
| Maximum messages per patient (total) | 5 |
| Minimum time between any two messages | 23 hours |
| Reactivation message | Sent once only |
| Health check message | Sent once only |
| Missed appointment messages | Day +1 and Day +3 only |

Staff can reset `message_count` to 0 in the sheet to re-enable messaging for a specific patient (e.g. after a new appointment booking).
