# Twilio WhatsApp Message Templates

Production proactive WhatsApp messages should use Twilio Content templates. Create templates in Twilio Content Template Builder, submit eligible WhatsApp templates for approval, and copy the Content SIDs into `.env`.

## Template Variables

Use positional variables in Twilio Content templates:

- `{{1}}` patient name
- `{{2}}` doctor or clinic depending on template
- `{{3}}` clinic or doctor depending on template

For exact mappings, run:

```bash
npm run generate:whatsapp-cards
```

This writes `build/whatsapp-cards.json` with Twilio-ready card bodies, variable maps, and sample `ContentVariables`.

## Core WhatsApp Cards

| Env var | Twilio friendly name | Purpose | Variables |
|---|---|---|---|
| `TWILIO_CONTENT_PATIENT_ONBOARDING` | `patient_onboarding` | First WhatsApp after patient QR intake | `{{1}}` patient, `{{2}}` clinic, `{{3}}` doctor, `{{4}}` visit detail |
| `TWILIO_CONTENT_HOSPITAL_ONBOARDING` | `hospital_onboarding` | Admin/ops notification after hospital signup | `{{1}}` hospital, `{{2}}` facility type, `{{3}}` doctor, `{{4}}` city |
| `TWILIO_CONTENT_PATIENT_REMINDER` | `patient_reminder` | Appointment, missed follow-up, health check, or reactivation reminder | `{{1}}` patient, `{{2}}` clinic, `{{3}}` doctor, `{{4}}` reminder detail |
| `TWILIO_CONTENT_MEDICINE_REMINDER` | `medicine_reminder` | Scheduled medicine dose reminder | `{{1}}` patient, `{{2}}` medicine, `{{3}}` dosage, `{{4}}` timing, `{{5}}` instruction |
| `TWILIO_CONTENT_PRESCRIPTION_DELIVERY` | `prescription_delivery` | Post-consultation prescription delivery | `{{1}}` patient, `{{2}}` doctor, `{{3}}` clinic, `{{4}}` medicine summary, `{{5}}` follow-up detail, `{{6}}` PDF URL |

Create or dry-run these in Twilio:

```bash
npm run push:twilio-templates -- --dry-run
npm run push:twilio-templates
npm run push:twilio-templates -- --submit-approval
```

The push script writes `build/twilio-template-push-results.json`. After creation, copy the returned `HX...` SIDs into `.env`.

## Legacy Per-Workflow SIDs

| Env var | Purpose | Variables |
|---|---|---|
| `TWILIO_CONTENT_WELCOME` | New patient welcome | `{{1}}` name, `{{2}}` clinic, `{{3}}` doctor |
| `TWILIO_CONTENT_FOLLOW_UP_REMINDER` | Day-before follow-up reminder | `{{1}}` name, `{{2}}` doctor, `{{3}}` clinic |
| `TWILIO_CONTENT_SAME_DAY_REMINDER` | Same-day appointment reminder | `{{1}}` name, `{{2}}` doctor, `{{3}}` clinic |
| `TWILIO_CONTENT_MISSED_RECOVERY` | Day +1 missed recovery | `{{1}}` name, `{{2}}` doctor |
| `TWILIO_CONTENT_MISSED_NUDGE` | Day +3 missed nudge | `{{1}}` name, `{{2}}` doctor, `{{3}}` clinic |
| `TWILIO_CONTENT_HEALTH_CHECK` | Post-visit health check | `{{1}}` name, `{{2}}` doctor |
| `TWILIO_CONTENT_REACTIVATION` | 30-day reactivation | `{{1}}` name, `{{2}}` clinic, `{{3}}` doctor |
| `TWILIO_CONTENT_HOSPITAL_ONBOARDING` | Hospital onboarding admin card | `{{1}}` hospital, `{{2}}` facility type, `{{3}}` doctor, `{{4}}` city |
| `TWILIO_CONTENT_PRESCRIPTION_DELIVERY` | Prescription card | `{{1}}` patient, `{{2}}` doctor, `{{3}}` clinic, `{{4}}` medicine summary, `{{5}}` PDF URL |

## Session Messages

WF6 auto-replies and WF8 admin alerts use Twilio `Body` messages. Patient-facing free-form replies should only be sent inside the 24-hour WhatsApp customer service window.

## Response Keywords

- Confirmed: `yes`, `confirm`, `confirmed`, `will come`, `coming`, `ok`, `okay`, `sure`
- Cancelled/reschedule: `no`, `cancel`, `reschedule`, `postpone`, `change date`
- Booking intent: `book`, `schedule`, `appointment`
- Help: `help`, `not well`, `pain`, `emergency`, `urgent`, `need doctor`, `call me`
