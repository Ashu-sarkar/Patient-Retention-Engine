# Setup Guide

Complete step-by-step deployment guide for the Patient Retention Engine.

Estimated setup time: **2–3 hours** for a non-technical person following this guide carefully.

---

## Prerequisites

- A Google account (for Google Sheets)
- A Twilio account (for WhatsApp messaging) — [sign up free](https://www.twilio.com/try-twilio)
- A server or hosting account for n8n (options below)
- Basic comfort with copy-pasting values between browser tabs

---

## Phase 1: Google Sheets Database

### Step 1.1 — Create the Spreadsheet

1. Go to [sheets.google.com](https://sheets.google.com)
2. Click **+ Blank** to create a new spreadsheet
3. Name it: `Patient Retention Engine`
4. You will see one sheet tab at the bottom called `Sheet1` — rename it to `Patients`
5. Click the `+` button at the bottom to add two more sheets: name them `Message_Logs` and `System_Logs`

### Step 1.2 — Add Column Headers

For each sheet, click on cell A1 and type the headers in Row 1.

**Patients sheet — paste this into A1 and press Tab between each column:**
```
id	name	phone	doctor_name	clinic_name	visit_date	follow_up_date	status	last_message_sent	message_count	response_status	last_response	health_check_sent	reactivation_sent	notes	created_at	updated_at
```

**Message_Logs sheet:**
```
log_id	patient_id	patient_name	phone	workflow_name	message_type	message_sent	sent_at	delivery_status	error_message	twilio_sid
```

**System_Logs sheet:**
```
log_id	timestamp	workflow_name	execution_id	log_level	message	details
```

### Step 1.3 — Format Columns

In the **Patients** sheet:
- Select column C (phone): `Format → Number → Plain text`
- Select columns F and G (visit_date, follow_up_date): `Format → Number → Plain text`
- Freeze row 1: `View → Freeze → 1 row`

### Step 1.4 — Get the Spreadsheet ID

Look at the URL in your browser. It will look like:
```
https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit
```

The long string between `/d/` and `/edit` is your Spreadsheet ID. Copy it — you will need it later.

### Step 1.5 — Create a Google Service Account (for n8n)

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use an existing one)
3. Navigate to **APIs & Services → Library**
4. Search for `Google Sheets API` and click **Enable**
5. Go to **APIs & Services → Credentials**
6. Click **+ Create Credentials → Service Account**
7. Give it a name (e.g. `n8n-sheets-access`) and click **Create**
8. On the next screen, skip optional fields and click **Done**
9. Click on the service account you just created
10. Go to the **Keys** tab → **Add Key → Create new key → JSON**
11. Download the JSON file — keep it safe, you'll need it for n8n

### Step 1.6 — Share the Spreadsheet with the Service Account

1. Open your service account JSON file and find the `client_email` field
   (it looks like: `n8n-sheets-access@your-project.iam.gserviceaccount.com`)
2. Open your Google Sheets spreadsheet
3. Click **Share** (top-right)
4. Paste the service account email
5. Set permission to **Editor**
6. Click **Share**

---

## Phase 2: WhatsApp Setup via Twilio (Phase 1–2)

### Step 2.1 — Create a Twilio Account

1. Go to [twilio.com/try-twilio](https://www.twilio.com/try-twilio) and sign up
2. Verify your phone number and email
3. On the Twilio Console dashboard, find your **Account SID** and **Auth Token** — copy both

### Step 2.2 — Activate WhatsApp Sandbox

1. In Twilio Console, go to **Messaging → Try it out → Send a WhatsApp message**
2. Follow the instructions to join the sandbox by sending a WhatsApp message from your phone
3. Note the sandbox number (usually `+14155238886`)
4. In **Sandbox Settings**, set the **When a message comes in** webhook URL to:
   ```
   https://YOUR_N8N_URL/webhook/feedback-listener
   ```
   (You'll fill in the actual URL after deploying n8n in Phase 3)

### Step 2.3 — Test Sending a Message

1. In the Twilio console, go to **Messaging → Try it out → Send a WhatsApp message**
2. Enter your own number and send a test message
3. Confirm you receive it on WhatsApp

---

## Phase 3: Deploy n8n

Choose one of these options:

### Option A: n8n.cloud (Easiest — Recommended for starting out)

1. Go to [n8n.cloud](https://n8n.cloud) and sign up for a free trial
2. Your n8n instance URL will be something like `https://yourname.app.n8n.cloud`
3. Skip Docker steps below — go directly to Phase 4

### Option B: Railway (Self-hosted — ~$5/month)

1. Go to [railway.app](https://railway.app) and sign up with GitHub
2. Click **New Project → Deploy from Template**
3. Search for `n8n` and select the official template
4. Click **Deploy**
5. After deployment, go to your service → **Settings → Domains → Generate Domain**
6. Note your public URL (e.g. `https://n8n-production-xxxx.up.railway.app`)
7. Set the following environment variables in Railway dashboard:
   ```
   N8N_BASIC_AUTH_ACTIVE=true
   N8N_BASIC_AUTH_USER=admin
   N8N_BASIC_AUTH_PASSWORD=choose_a_strong_password
   GENERIC_TIMEZONE=Asia/Kolkata
   N8N_HOST=your-railway-domain.up.railway.app
   N8N_PROTOCOL=https
   WEBHOOK_URL=https://your-railway-domain.up.railway.app/
   ```

### Option C: Docker (Self-hosted — local or VPS)

```bash
docker run -d \
  --name n8n \
  -p 5678:5678 \
  -e N8N_BASIC_AUTH_ACTIVE=true \
  -e N8N_BASIC_AUTH_USER=admin \
  -e N8N_BASIC_AUTH_PASSWORD=your_password \
  -e GENERIC_TIMEZONE=Asia/Kolkata \
  -e WEBHOOK_URL=https://your-public-url.com/ \
  -v n8n_data:/home/node/.n8n \
  n8nio/n8n
```

---

## Phase 4: Configure n8n Credentials

### Step 4.1 — Add Google Sheets Credential

1. Open your n8n instance and log in
2. Go to **Settings (gear icon) → Credentials → + Add Credential**
3. Search for `Google Sheets` and select **Google Sheets OAuth2 API** (or **Service Account** if using service account JSON)
4. If using **Service Account**:
   - Upload your service account JSON file, or paste its contents
5. If using **OAuth2**:
   - Follow the OAuth flow with your Google account
6. Name the credential: `Google Sheets account`
7. Click **Save**

### Step 4.2 — Add Twilio Credential (for WhatsApp)

1. Go to **Credentials → + Add Credential**
2. Search for `HTTP Basic Auth` and select it
3. Fill in:
   - **Username**: your Twilio Account SID
   - **Password**: your Twilio Auth Token
4. Name it: `Twilio Basic Auth`
5. Click **Save**

### Step 4.3 — Add Environment Variables

In n8n, go to **Settings → Environment Variables** and add:

```
GOOGLE_SHEETS_ID = your_spreadsheet_id
TWILIO_ACCOUNT_SID = ACxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN = your_auth_token
TWILIO_WHATSAPP_NUMBER = whatsapp:+14155238886
ADMIN_WHATSAPP_NUMBER = whatsapp:+919876543210
DEFAULT_CLINIC_NAME = Your Clinic Name
DEFAULT_DOCTOR_NAME = Dr. Name
TIMEZONE = Asia/Kolkata
```

---

## Phase 5: Import n8n Workflows

### Step 5.1 — Import Each Workflow

For each JSON file in the `n8n-workflows/` folder:

1. In n8n, click **+ (New Workflow)** in the top-left
2. Click the **three-dot menu (⋮)** at the top-right of the workflow editor
3. Select **Import from File**
4. Upload the workflow JSON file
5. The workflow will open with all nodes pre-configured
6. **Update credentials**: click on any Google Sheets node → set credential to `Google Sheets account`. Repeat for HTTP Request (Twilio) nodes → set to `Twilio Basic Auth`

### Step 5.2 — Import Order (recommended)

1. `workflow-8-error-handler.json` — import first (other workflows reference it)
2. `workflow-7-new-patient.json`
3. `workflow-1-followup-reminder.json`
4. `workflow-2-sameday-reminder.json`
5. `workflow-3-missed-appointment.json`
6. `workflow-4-health-check.json`
7. `workflow-5-reactivation.json`
8. `workflow-6-feedback-listener.json` — import last (webhook-based)

---

## Phase 6: Configure Webhook URL for Inbound Messages

### Step 6.1 — Get Your Webhook URL

1. Open `workflow-6-feedback-listener` in n8n
2. Click on the **Webhook** node
3. Copy the **Production URL** shown in the node (it looks like `https://your-n8n.app/webhook/feedback-listener`)

### Step 6.2 — Register with Twilio

1. Go to your Twilio Console → **Messaging → Sandbox Settings**
2. In the field **When a message comes in**, paste the webhook URL
3. Set the method to `HTTP POST`
4. Click **Save**

### Step 6.3 — Register with Meta (Phase 3+ only)

1. Go to your Meta Developer App → **WhatsApp → Configuration**
2. In **Webhook**, click **Edit**
3. Set **Callback URL** to your webhook URL
4. Set **Verify Token** to the value of `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN` in your env
5. Click **Verify and Save**
6. Subscribe to the `messages` webhook field

---

## Phase 7: Activate and Test

### Step 7.1 — Activate Workflows

1. Open each workflow in n8n
2. Click the **Active** toggle (top-right) to turn it ON
3. Confirm each workflow shows "Active" status on the workflows list

### Step 7.2 — Test with a Sample Patient

1. Add a test patient row to the Patients sheet:
   ```
   name: Test Patient
   phone: +91[your_own_number]
   doctor_name: Dr. Test
   clinic_name: Test Clinic
   visit_date: [today's date in YYYY-MM-DD]
   follow_up_date: [tomorrow's date in YYYY-MM-DD]
   status: pending
   message_count: 0
   ```
2. Leave all other fields blank
3. The Workflow 7 (New Patient) will detect the new row within 1 minute and send a welcome message
4. You should receive a WhatsApp message on the number you entered

### Step 7.3 — Manually Trigger a Workflow for Testing

1. Open any workflow in n8n
2. Click **Test workflow** (or **Execute Workflow**) in the top-right
3. The workflow will run immediately with the current data
4. Check the execution results in the n8n UI and verify Google Sheets was updated

---

## Phase 8: WhatsApp Template Approval (Meta Cloud API Only)

If you are using **Meta Cloud API** (not Twilio), you must submit message templates for approval before sending outbound messages.

### Step 8.1 — Access Template Manager

1. Go to [business.facebook.com](https://business.facebook.com)
2. Navigate to **WhatsApp Manager → Message Templates**
3. Click **Create Template**

### Step 8.2 — Submit Templates

Submit each template from `docs/message-templates.md`. Required templates:
- `follow_up_reminder`
- `same_day_reminder`
- `missed_appointment_recovery`
- `missed_appointment_nudge`
- `health_check`
- `reactivation`
- `welcome`

### Step 8.3 — Approval Timeline

- Templates typically take **24–72 hours** for Meta to review
- Status can be: **Approved**, **Rejected**, or **Pending**
- If rejected, edit and resubmit — Meta usually provides a rejection reason

---

## Troubleshooting

### Messages Not Sending

- Check that the workflow is **Active** in n8n
- Verify the patient `phone` field has the correct format (`+919876543210`)
- Check **n8n → Executions** to see if the workflow ran and any errors
- Verify Twilio credentials are correct in n8n
- For Twilio sandbox: the recipient must have joined the sandbox first

### Google Sheets Not Updating

- Verify the Google Sheets credential is connected in the node
- Check that the service account has **Editor** access to the spreadsheet
- Confirm `GOOGLE_SHEETS_ID` matches your actual spreadsheet ID

### Webhook Not Receiving Messages

- Confirm Workflow 6 is **Active**
- Verify the webhook URL was correctly set in Twilio/Meta
- In Twilio Console → **Monitor → Logs → Messaging** to see incoming message events
- Test the webhook with a tool like [webhook.site](https://webhook.site)

### Duplicate Messages Being Sent

- Each workflow checks `message_count` and `last_message_sent` before acting
- If duplicates occur, check if multiple instances of n8n are running
- Verify the Google Sheets Update node is correctly incrementing `message_count`

---

## Going to Production (Meta Cloud API)

When ready to move from Twilio sandbox to Meta production:

1. Set up Meta Business Account and get approved for WhatsApp Business API
2. Get a dedicated WhatsApp number
3. Update env vars: `META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`
4. In n8n workflows, update the HTTP Request nodes to use Meta API endpoint:
   ```
   POST https://graph.facebook.com/v18.0/{{PHONE_NUMBER_ID}}/messages
   ```
5. Switch body format from form-urlencoded (Twilio) to JSON (Meta)
6. Use approved template names in the message body
