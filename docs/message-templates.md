# Twilio WhatsApp Message Templates

Production proactive WhatsApp messages should use Twilio Content templates. Create templates in Twilio Content Template Builder, submit eligible WhatsApp templates for approval, and copy the Content SIDs into `.env`.

## Template Variables

Use positional variables in Twilio Content templates:

- `{{1}}` patient name
- `{{2}}` doctor or clinic depending on template
- `{{3}}` clinic or doctor depending on template

## Required Content SIDs

| Env var | Purpose | Variables |
|---|---|---|
| `TWILIO_CONTENT_WELCOME` | New patient welcome | `{{1}}` name, `{{2}}` clinic, `{{3}}` doctor |
| `TWILIO_CONTENT_FOLLOW_UP_REMINDER` | Day-before follow-up reminder | `{{1}}` name, `{{2}}` doctor, `{{3}}` clinic |
| `TWILIO_CONTENT_SAME_DAY_REMINDER` | Same-day appointment reminder | `{{1}}` name, `{{2}}` doctor, `{{3}}` clinic |
| `TWILIO_CONTENT_MISSED_RECOVERY` | Day +1 missed recovery | `{{1}}` name, `{{2}}` doctor |
| `TWILIO_CONTENT_MISSED_NUDGE` | Day +3 missed nudge | `{{1}}` name, `{{2}}` doctor, `{{3}}` clinic |
| `TWILIO_CONTENT_HEALTH_CHECK` | Post-visit health check | `{{1}}` name, `{{2}}` doctor |
| `TWILIO_CONTENT_REACTIVATION` | 30-day reactivation | `{{1}}` name, `{{2}}` clinic, `{{3}}` doctor |

## Session Messages

WF6 auto-replies and WF8 admin alerts use Twilio `Body` messages. Patient-facing free-form replies should only be sent inside the 24-hour WhatsApp customer service window.

## Response Keywords

- Confirmed: `yes`, `confirm`, `confirmed`, `will come`, `coming`, `ok`, `okay`, `sure`
- Cancelled/reschedule: `no`, `cancel`, `reschedule`, `postpone`, `change date`
- Booking intent: `book`, `schedule`, `appointment`
- Help: `help`, `not well`, `pain`, `emergency`, `urgent`, `need doctor`, `call me`
