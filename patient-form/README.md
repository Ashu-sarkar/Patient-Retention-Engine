# Patient Registration Form — QR Code Intake

A zero-dependency, mobile-first HTML form that clinic patients fill by scanning a QR code. Data is sent directly to an n8n webhook (WF11), which upserts the patient into Supabase by WhatsApp phone number, creates a `patient_visits` waiting-room row, and triggers the welcome WhatsApp message. Clinical context is captured later in the doctor dashboard, not on the patient intake form.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| n8n running with WF11 active | WF11 must be **activated** before deploying |
| Public HTTPS URL for n8n | Needed for the webhook URL in `index.html` |
| Vercel or Netlify account | Free tier is fine |

---

## Step 1 — Configure the Form

Open `patient-form/index.html` and update the two config blocks near the top of the `<script>` section:

```js
// 1. Replace with your real n8n public webhook URL
const WEBHOOK_URL = 'https://your-n8n-domain.com/webhook/patient-form-intake';

// 2. Replace with your real hospitals and their doctors
const HOSPITALS = {
  'City Hospital':    ['Dr. Sharma', 'Dr. Mehta', 'Dr. Patel', 'Dr. Divya Rai Shukla'],
  'General Hospital': ['Dr. Kumar', 'Dr. Patel', 'Dr. Sharma'],
  'Metro Clinic':     ['Dr. Mehta', 'Dr. Kumar'],
};
```

> **Do not** add `+91` to the webhook URL or phone numbers.  
> WF11 automatically prepends `+91` before saving to Supabase.

---

## Step 2 — Deploy

### Option A — Vercel (recommended)

```bash
# Install Vercel CLI (one-time)
npm install -g vercel

# From the patient-form/ directory
cd patient-form
vercel --prod
```

Vercel detects `index.html` and deploys as a static site. Free plan gives HTTPS automatically.

### Option B — Netlify (drag & drop — no CLI needed)

1. Go to [app.netlify.com](https://app.netlify.com)
2. Drag the `patient-form/` folder onto the **"Deploy manually"** drop zone
3. Done — you get a `https://xxx.netlify.app` URL

### Option C — Netlify CLI

```bash
npm install -g netlify-cli
cd patient-form
netlify deploy --prod --dir .
```

---

## Step 3 — Test Before Generating the QR Code

Open the deployed URL in your phone browser and submit a test entry:

- Patient Name: `Test Patient`
- Phone: `9876543210`
- Hospital: *(select any)*
- Doctor: *(select any)*
- Visit Date: *(today)*
- Follow-up: `No`

Check n8n → WF11 executions and Supabase `public.patients` plus `public.patient_visits` to confirm the patient and visit queue record were created.

---

## Step 4 — Generate QR Codes

Each hospital/clinic can have its own QR code that pre-fills the hospital dropdown.

### URL format

```
https://your-form.vercel.app/?hospital=City+Hospital
https://your-form.vercel.app/?hospital=General+Hospital
https://your-form.vercel.app/?hospital=Metro+Clinic
```

The `hospital` URL param must match a key in the `HOSPITALS` config exactly (case-insensitive match is applied automatically).

### Free QR Code generators

| Tool | URL |
|------|-----|
| QR Code Generator | https://www.qr-code-generator.com |
| QRCode Monkey | https://www.qrcodemonkey.com |
| GoQR.me | https://goqr.me |

**Recommended settings:**
- Format: SVG or PNG 1000×1000 px
- Error correction: **M** or **H** (for clinic print)
- Test scan before printing

### Bulk QR code for all hospitals (one QR)

```
https://your-form.vercel.app/
```

Leave out the `?hospital=` param — staff will select the hospital from the dropdown manually.

---

## Step 5 — Activate WF11 in n8n

1. Open n8n → **Workflows** → `WF11 — QR Form Intake`
2. Set credentials on the three Postgres nodes → your Supabase connection
3. Click **Activate** (toggle in the top-right)
4. Copy the **Production Webhook URL** shown on the `Webhook — Form Intake` node
5. Paste it as `WEBHOOK_URL` in `index.html` (must start with `https://`)
6. Redeploy the form

> **Order matters**: Activate WF11 and WF7 **before** deploying the QR form in the clinic.

---

## Environment Flow

```
Patient scans QR
      │
      ▼
index.html  (POST JSON)
      │
      ▼  https://n8n.your-domain.com/webhook/patient-form-intake
WF11 — QR Form Intake
      │  validates identity/routing fields
      │  generates PAT-XXXX code
      ├──► Supabase public.patients  (identity upsert by phone)
      ├──► Supabase public.patient_visits  (new waiting queue row)
      │
      └──► WF7 — New Patient Welcome (async HTTP call)
                  │
                  └──► Twilio WhatsApp: welcome message to patient

Doctor dashboard
      │
      └──► Updates public.patient_visits with chief complaint, symptoms duration,
           allergies, current medicines, existing conditions, and vitals notes.
```

---

## URL Parameters Reference

| Param | Description | Example |
|-------|-------------|---------|
| `hospital` | Pre-fills and locks hospital dropdown | `?hospital=City+Hospital` |
| `clinic` | Alias for `hospital` | `?clinic=Metro+Clinic` |
| `title` | Display label in the header badge | `?title=City+Hospital+Wing+B` |

Combine them:
```
https://your-form.vercel.app/?hospital=City+Hospital&title=City+Hospital+%E2%80%94+Wing+B
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Form shows "Something went wrong" | Check WF11 is activated; check n8n URL in `WEBHOOK_URL`; check CORS — n8n webhook allows `*` by default |
| Doctor dropdown stays disabled | The `hospital` URL param must exactly match a key in `HOSPITALS` (case-insensitive) |
| `patient_code` or `visit_id` not shown on success | WF11 should return both after a successful patient upsert and visit insert |
| Form loads but is blank on some Android phones | Ensure the hosting URL is HTTPS — HTTP blocks `fetch()` on Android Chrome |
| Webhook returns 400 | A required field is missing; check browser Network tab → response body for the list of errors |
