# Patient Registration Form — Clinic QR Intake

A zero-dependency, mobile-first HTML form that clinic patients fill by scanning a **per-clinic QR code**. Each QR encodes an opaque intake token; the form resolves that token to the clinic and its doctors, then posts patient details to n8n (WF11).

Data is sent to WF11, which upserts the patient into Supabase by WhatsApp phone number, creates a `patient_visits` waiting-room row, and triggers the welcome WhatsApp message. Clinical context is captured later in the doctor dashboard, not on the patient intake form.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| n8n running with WF11 active | WF11 must be **activated** before deploying |
| Public HTTPS URL for n8n | Needed for the webhook URL in `index.html` |
| Admin console QR for each clinic | Generate per-clinic tokens from **Admin → Generate clinic QR** |
| Vercel or Netlify account | Free tier is fine |

---

## How clinic routing works

1. Platform admin onboards a clinic (hospital boarding form / WF12).
2. Admin opens the platform console and generates a QR for that clinic.
3. Patient scans the QR → browser opens the patient form with `#/i/<64-char-token>`.
4. Form calls `resolve_public_intake_token` and loads doctors for that clinic only.
5. Patient selects a doctor and submits; WF11 validates the token server-side and creates the visit.

There is **no hospital dropdown** on the public form. Clinic identity always comes from the QR token.

---

## QR URL format

Preferred (token stays in the URL fragment, not sent to static hosting logs):

```text
https://your-patient-form.vercel.app/#/i/<64-char-hex-token>
```

Also supported (path rewrite via `patient-form/vercel.json`):

```text
https://your-patient-form.vercel.app/i/<64-char-hex-token>
```

Generate tokens and printable QR images from the **platform admin console** (`admin-console/index.html` → **Generate clinic QR**).

---

## Step 1 — Configure the form

Open `patient-form/index.html` and set the webhook target in the `<script>` section (or override at runtime via `window.VAITALCARE_CONFIG` / localStorage).

Production deployments use the Vercel proxy path `/api/patient-form-intake` by default.

> **Do not** add `+91` to phone numbers in the form.  
> WF11 automatically prepends `+91` before saving to Supabase.

---

## Step 2 — Deploy

### Option A — Vercel (recommended)

```bash
npm install -g vercel
cd patient-form
vercel --prod
```

Set the **Patient form base URL** in the admin console to this deployed URL when generating QRs.

### Option B — Netlify drag & drop

1. Go to [app.netlify.com](https://app.netlify.com)
2. Drag the `patient-form/` folder onto **Deploy manually**

---

## Step 3 — Test with a clinic QR

1. Onboard a test clinic (hospital boarding form).
2. In the admin console, generate a QR for that clinic.
3. Open the scan URL on your phone.
4. Confirm the header badge shows the clinic name and the doctor dropdown lists that clinic's doctors.
5. Submit a test patient and verify WF11 + Supabase rows.

Example test values:

- Patient Name: `Test Patient`
- Phone: `9876543210`
- Doctor: *(select from clinic list)*
- Visit Date: *(today)*

---

## Step 4 — Activate WF11 in n8n

1. Open n8n → **Workflows** → `WF11 — QR Form Intake`
2. Set credentials on Postgres nodes → your Supabase connection
3. Click **Activate**
4. Redeploy the patient form if you changed the webhook URL

> **Order matters**: Activate WF11 and WF7 **before** printing clinic QRs.

---

## Environment flow

```text
Patient scans clinic QR (#/i/<token>)
      │
      ▼
index.html
  │  resolve_public_intake_token → clinic + doctors
  │  POST intake_token + doctor + patient fields
      ▼
WF11 — QR Form Intake
  │  validates token server-side
  │  generates patient code
  ├──► Supabase public.patients
  ├──► Supabase public.patient_visits
  └──► WF7 — welcome WhatsApp

Doctor dashboard
  └──► Updates visit clinical context after check-in
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Form says "Invalid clinic QR" | Open via admin-generated QR URL; bare `/` has no token |
| Doctor dropdown stays on "Loading doctors…" | Token inactive/expired, or clinic has no doctors in boarding/profiles |
| Form shows "Something went wrong" | Check WF11 is activated; check webhook URL and CORS |
| Webhook returns 400 on `intake_token` | Token missing or malformed; rescan the clinic QR |
| `patient_code` not shown on success | WF11 should return `{ status: "success", patient_code, visit_id }` |
