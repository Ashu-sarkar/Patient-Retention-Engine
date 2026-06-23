# Production Test Playbook

Run these commands from the **repo root** after copying `.env.example` → `.env` and filling production values.

**Default test phone:** `9685722570` (`+919685722570`) — used for patient intake, doctor login, and WhatsApp delivery tests.

| Surface | URL |
|---------|-----|
| Patient form | https://vaitalcare-patient.vercel.app/ |
| Hospital form | https://vaitalcare-hospital.vercel.app/ |
| Doctor dashboard | https://vaitalcare-doctor.vercel.app/ |
| n8n (Railway) | https://vaitalcare-production.up.railway.app |

---

## 0. One-time setup

```bash
# Install Node 18+ and project deps
npm install

# Validate required env vars (Twilio, Supabase, n8n, templates)
npm run validate-env

# Align Supabase schema (run before first deploy or after migrations)
npm run preflight

# Sync prescription WhatsApp edge-function secrets + deploy functions
npm run sync:prescription-secrets
```

**Railway DNS note:** If `curl` to Railway fails with `ENOTFOUND`, use the resolve helper (see `commands.sh`):

```bash
source production-test-playbook/commands.sh
railway_curl https://vaitalcare-production.up.railway.app/healthz
```

Update `RAILWAY_RESOLVE_IP` in `commands.sh` if the Railway IP changes (`dig +short vaitalcare-production.up.railway.app`).

---

## 1. Quick smoke (start here after any production incident)

```bash
# --- 1.1 Env + Supabase schema sanity ---
npm run validate-env
npm run preflight

# --- 1.2 n8n alive (expect HTTP 200 + {"status":"ok"}) ---
curl -sS https://vaitalcare-production.up.railway.app/healthz

# --- 1.3 Webhooks registered (expect HTTP 400 JSON validation, NOT 404 HTML) ---
curl -sS -X POST https://vaitalcare-production.up.railway.app/webhook/patient-form-intake \
  -H 'Content-Type: application/json' -d '{}'

curl -sS -X POST https://vaitalcare-production.up.railway.app/webhook/hospital-boarding \
  -H 'Content-Type: application/x-www-form-urlencoded' -d ''

# --- 1.4 Automated production API E2E (Railway + Supabase, phone 9685722570) ---
npm run test:production-e2e

# --- 1.5 Browser UI E2E (Vercel forms + username/password doctor dashboard) ---
HEADED=1 DOCTOR_DASHBOARD_URL=https://vaitalcare-doctor.vercel.app \
  E2E_PHONE_RAW=9685722570 \
  E2E_DOCTOR_USERNAME=browser.doctor \
  E2E_DOCTOR_PASSWORD=BrowserPass123 \
  npm run test:production-browser

# --- 1.6 Admin console browser E2E ---
ADMIN_CONSOLE_URL=https://your-admin-console.example \
  ADMIN_USERNAME=founder \
  ADMIN_PASSWORD='change-this-strong-password' \
  npm run test:production-admin
```

**Healthy webhook:** `HTTP 400` with `{"status":"error","message":"Validation failed",...}`  
**Broken webhook:** `HTTP 404` with `Cannot POST` or `Active version not found`.

---

## 2. Local / Docker integration suite (full workflow coverage)

Use when debugging on a **local** stack (`docker compose up`, n8n at `http://localhost:5678`).

```bash
# Start stack
docker compose up -d --build

# Import workflows, credentials, activate published versions
npm run setup

# Full integration tests (WF11, WF12, WF6, WF7, WF9, WF1–WF5, E2E)
# Uses test phones 900000XXXX — does NOT use 9685722570
npm test

# Or setup + test in one command
npm run test:setup-and-run
```

### What `npm test` covers

| Section | Workflow | Tests |
|---------|----------|-------|
| §1 | Infrastructure | Supabase, n8n health, all workflows active |
| §2 | **WF12** Hospital boarding | Happy path, DB row, validation edge cases |
| §3 | **WF11** Patient intake | Happy path, visit queue, validation, duplicate phone, SQL injection |
| §4 | **WF7** New patient welcome | Valid payload, invalid phone/name skip |
| §5 | **WF6** Feedback + **WF9** status | confirm/cancel/help/unknown/blank/status callback |
| §6 | **WF1–WF5** Cron logic | DB filter simulation per workflow |
| §7 | Cron manual trigger | Optional n8n API run (needs `N8N_API_KEY`) |
| §8 | **E2E** | Intake → DB → feedback confirm → re-register |

---

## 3. Production API E2E (automated)

```bash
# Default: phone 9685722570, hospital "VaitalCare E2E Hospital"
npm run test:production-e2e

# Custom phone / clinic
E2E_PHONE_RAW=9685722570 \
E2E_HOSPITAL="City Hospital" \
E2E_DOCTOR="Dr. Sharma" \
npm run test:production-e2e
```

| Test block | What it verifies |
|------------|------------------|
| §1 Infrastructure | Railway healthz, WF11 empty → 400 |
| §2 WF12 | Valid boarding, DB, invalid facility_type |
| §3 WF11 | Valid intake, future date, bad follow-up date, re-registration |
| §4 Dashboard path | Boarding enables profile; visits exist for clinic+doctor; hospital list RPC |

---

## 4. Individual workflow tests (production curl)

Source helpers first:

```bash
source production-test-playbook/commands.sh
export E2E_PHONE_RAW=9685722570
export TODAY=$(date +%Y-%m-%d)
export YESTERDAY=$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d 'yesterday' +%Y-%m-%d)
export TOMORROW=$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d 'tomorrow' +%Y-%m-%d)
```

### WF12 — Hospital boarding (`/webhook/hospital-boarding`)

On success, WF12 sends the approved `hospital_onboarding` Twilio template to **clinic `contact_phone`** and **`doctor_phone`** when they differ. Requires `TWILIO_CONTENT_HOSPITAL_ONBOARDING` in n8n and an updated WF12 workflow (re-run `npm run setup:n8n` after deploy).

```bash
# Happy path — creates doctor profile bootstrap data (doctor_phone = +919685722570)
railway_post_form hospital-boarding \
  "hospital_name=City Hospital&facility_type=Pathology Lab&address=12 Test Road&city=Bangalore&contact_phone=9685722570&admin_contact_name=Test Admin&clinic_email=test@test.com&clinic_website=https://example.com&doctor_name=Dr. Sharma&doctor_qualification=MBBS&doctor_expertise=General Medicine&doctor_registration_number=TN-TEST-001&doctor_phone=%2B919685722570&consultation_hours=Mon-Sat 9-5"

# Edge: invalid facility_type → expect 400
railway_post_form hospital-boarding \
  "hospital_name=Bad Facility Hospital&facility_type=Veterinary Clinic&address=x&city=x&contact_phone=9685722570&admin_contact_name=x&doctor_name=Dr X&doctor_qualification=MBBS&doctor_expertise=x&doctor_registration_number=x&doctor_phone=%2B919685722570&consultation_hours=x"

# Edge: missing doctor_name → expect 400
railway_post_form hospital-boarding \
  "hospital_name=Bad Doctor Hospital&facility_type=Pathology Lab&address=x&city=x&contact_phone=9685722570&admin_contact_name=x&doctor_name=&doctor_qualification=MBBS&doctor_expertise=x&doctor_registration_number=x&doctor_phone=%2B919685722570&consultation_hours=x"
```

### WF11 — Patient intake (`/webhook/patient-form-intake`)

```bash
# Happy path — creates patient + waiting visit (form-encoded like the QR form)
railway_post_form patient-form-intake \
  "patient_name=Prod Test Patient&phone_number=${E2E_PHONE_RAW}&dob=1990-01-15&sex=Male&hospital_name=City Hospital&doctor_name=Dr. Sharma&visit_date=${YESTERDAY}&follow_up_required=No"

# Edge: empty body → 400
railway_post_json patient-form-intake '{}'

# Edge: invalid phone → 400
railway_post_form patient-form-intake \
  "patient_name=Test&phone_number=12345&hospital_name=City Hospital&doctor_name=Dr. Sharma&visit_date=${YESTERDAY}&follow_up_required=No"

# Edge: future visit_date → 400
railway_post_form patient-form-intake \
  "patient_name=Test&phone_number=${E2E_PHONE_RAW}&hospital_name=City Hospital&doctor_name=Dr. Sharma&visit_date=${TOMORROW}&follow_up_required=No"

# Edge: follow-up date not after visit → 400
railway_post_form patient-form-intake \
  "patient_name=Test&phone_number=${E2E_PHONE_RAW}&hospital_name=City Hospital&doctor_name=Dr. Sharma&visit_date=${YESTERDAY}&follow_up_required=Yes&follow_up_date=${YESTERDAY}"

# Edge: duplicate re-registration (same phone) → 200, updates doctor_name
railway_post_form patient-form-intake \
  "patient_name=Prod Test Updated&phone_number=${E2E_PHONE_RAW}&hospital_name=City Hospital&doctor_name=Dr. Sharma&visit_date=${YESTERDAY}&follow_up_required=Yes&follow_up_date=${TOMORROW}"
```

### WF7 — New patient welcome (`/webhook/new-patient-intake`)

```bash
# Called internally by WF11; test directly with JSON
railway_post_json new-patient-intake '{
  "patient_code": "PAT-TEST",
  "name": "WF7 Test",
  "phone": "+919685722570",
  "clinic_name": "City Hospital",
  "doctor_name": "Dr. Sharma",
  "visit_date": "'"${YESTERDAY}"'",
  "follow_up_required": "No"
}'
```

### WF6 — Inbound WhatsApp (`/webhook/feedback-listener`)

```bash
# Patient confirms appointment (Twilio form fields)
railway_post_form feedback-listener \
  "From=whatsapp:%2B919685722570&To=whatsapp:%2B14155238886&Body=Yes+I+will+come&MessageSid=SM00000000000000000000000000000001&WaId=919685722570&ProfileName=Test&NumMedia=0"

# Patient cancels
railway_post_form feedback-listener \
  "From=whatsapp:%2B919685722570&Body=No+please+cancel&MessageSid=SM00000000000000000000000000000002"

# Unknown number → 200 + WARN in system_logs
railway_post_form feedback-listener \
  "From=whatsapp:%2B919999999999&Body=Hello&MessageSid=SM00000000000000000000000000000003"
```

### WF9 — Twilio status callback (`/webhook/twilio-status-callback`)

```bash
railway_post_form twilio-status-callback \
  "MessageSid=SM00000000000000000000000000000001&MessageStatus=delivered"
```

### WF13 — Prescription delivery (n8n — legacy path)

Production **doctor dashboard** uses the Supabase `prescription-delivery` edge function (Twilio direct). WF13 is still useful to verify n8n config:

```bash
# Unsigned → 400 validation
railway_post_json prescription-delivery '{}'

# Signed call (requires INTERNAL_WEBHOOK_SECRET from .env) — see commands.sh
# sign_and_post_prescription <prescription-uuid>
```

---

## 5. Doctor dashboard + prescription WhatsApp (manual)

```bash
# 1. Open dashboard, log in with the username/password created during hospital onboarding
open https://vaitalcare-doctor.vercel.app/

# 2. Ensure hospital boarding exists for your clinic/doctor (WF12 above)

# 3. Submit patient intake (WF11) or use patient form URL

# 4. In dashboard: select visit → fill medicines → click "Issue Prescription"

# 5. Verify in Supabase:
source production-test-playbook/commands.sh
verify_patient_state +919685722570
verify_prescription_delivery +919685722570
```

Expected after successful issue:

- `prescriptions.delivery_status` = `sent`
- `message_logs` row with `message_type` = `prescription_pdf`
- WhatsApp message with **short PDF link** (tap to open PDF)

---

## 6. Supabase verification queries

```bash
# Patient + recent visits
node production-test-playbook/verify.js patient +919685722570

# Latest prescriptions + delivery_status + message_logs
node production-test-playbook/verify.js prescriptions +919685722570

# Recent system_logs for a workflow
node production-test-playbook/verify.js logs workflow-13-prescription-delivery
node production-test-playbook/verify.js logs workflow-11-form-intake
```

Or use `commands.sh`:

```bash
source production-test-playbook/commands.sh
verify_patient_state +919685722570
verify_prescription_delivery +919685722570
verify_system_logs workflow-13-prescription-delivery
```

---

## 7. Cron workflows (WF1–WF5)

These run on a schedule in n8n. On production, confirm in n8n UI that WF1–WF5 are **active** and Twilio template env vars are set.

Local test (DB filter logic only):

```bash
npm test
# See §6 in output — WF1–WF5 query simulation
```

Manual trigger (needs `N8N_API_KEY` in `.env`):

```bash
# Re-run setup, then npm test §7 — or trigger from n8n UI manually
```

---

## 8. Troubleshooting matrix

| Symptom | Likely cause | Command / fix |
|---------|--------------|---------------|
| CORS on prescription send | Wrong `DOCTOR_DASHBOARD_ORIGIN` | `npm run sync:prescription-secrets` |
| `delivery_status: queued` forever | Old n8n-only path failed | Re-issue; edge function now sends Twilio directly |
| Webhook `404 Cannot POST` | WF not active / wrong URL | `npm run setup` locally; redeploy Railway |
| Webhook `404 Active version not found` | Published version missing | Redeploy Railway; check `start.sh` logs |
| `TWILIO_CONTENT_* required` in WF13 logs | Railway env missing template SID | Set `TWILIO_CONTENT_PRESCRIPTION_DELIVERY` on Railway |
| Patient not in dashboard queue | RLS / clinic name mismatch | WF12 boarding must match visit `clinic_name` + `doctor_name` |
| No WhatsApp received | Twilio template / session window | Check `message_logs`; retry issue; see edge function error toast |

---

## 9. Command reference (npm scripts)

| Command | Purpose |
|---------|---------|
| `npm run validate-env` | Fail fast if `.env` missing required keys |
| `npm run preflight` | Supabase migrations + schema |
| `npm run setup` | n8n credentials + workflow import/activate |
| `npm test` | Full local integration + edge cases |
| `npm run test:setup-and-run` | preflight + setup + test |
| `npm run test:production-e2e` | Production Railway + Supabase API tests |
| `npm run test:production-browser` | Vercel form UI automation (Playwright) |
| `npm run sync:prescription-secrets` | Deploy edge functions + Twilio secrets |

---

## 10. Files in this folder

| File | Purpose |
|------|---------|
| `README.md` | This playbook |
| `commands.sh` | Sourceable shell helpers (`railway_curl`, `verify_*`, etc.) |
| `verify.js` | Small Node helpers for Supabase checks |

Keep this folder updated when adding new workflows or test scripts.
