# Doctor Dashboard

Authenticated Supabase dashboard for the clinic/doctor queue and prescription workflow. Doctors sign in with the WhatsApp number captured during hospital onboarding.

## Configure

Open `doctor-dashboard/index.html` and replace:

```js
const SUPABASE_URL = 'https://crsdccqseuhnimoxxeky.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
const PRESCRIPTION_DELIVERY_FUNCTION = 'prescription-delivery';
```

`SUPABASE_ANON_KEY` must be copied from Supabase Project Settings -> API. WF13 and the `prescription-delivery` Supabase Edge Function must be deployed before prescription WhatsApp delivery works.

The login URL to share with doctors is the deployed static URL for this folder, for example:

```text
https://your-domain.example/doctor-dashboard/
```

For local preview, open `doctor-dashboard/index.html?demo=1`.

## WhatsApp OTP Login

1. Enable phone OTP in Supabase Auth.
2. Configure the Supabase Auth SMS provider to deliver OTPs through WhatsApp where supported by your provider setup.
3. Ensure the hospital onboarding form captures each doctor's WhatsApp number in international format, for example `+919876543210`.
4. Run `npm run preflight` so Supabase has the phone-matching RPC and RLS policies.

## Secure Prescription Delivery

The browser dashboard does not call n8n directly. After a prescription PDF is issued, it invokes the Supabase Edge Function `prescription-delivery` with only `prescription_id`. The function verifies the doctor session, loads the prescription from Supabase, and sends WhatsApp via Twilio (template card with a short PDF link, or PDF attachment as fallback). Sync secrets with `npm run sync:prescription-secrets`.

Set these Supabase function secrets before deployment:

```bash
supabase secrets set N8N_PRESCRIPTION_DELIVERY_URL=https://your-n8n.example.com/webhook/prescription-delivery
supabase secrets set INTERNAL_WEBHOOK_SECRET="$(openssl rand -hex 32)"
# Comma-separated; Vercel preview URLs matching vaitalcare-doctor*.vercel.app are allowed by default
supabase secrets set DOCTOR_DASHBOARD_ORIGIN=https://vaitalcare-doctor.vercel.app,http://localhost:3000
```

Use the same `INTERNAL_WEBHOOK_SECRET` in the n8n runtime environment so WF13 can verify `X-Internal-Signature`.

At login, the dashboard sends an OTP to the entered WhatsApp number. After verification, Supabase issues the authenticated session. The dashboard then calls `get_or_create_doctor_profile_for_current_user()`:

- If a `doctor_profiles.user_id` already matches the session, that profile is used.
- If a profile has the same `doctor_phone`, it is claimed by setting `user_id`.
- If no profile exists but the latest `hospital_boarding.doctor_phone` matches, a profile is created from hospital onboarding.
- If no match exists, login succeeds but dashboard access is blocked with a profile-not-found notice.

## Doctor Accounts

Manual profile creation is optional if hospital onboarding already has `doctor_phone`, `doctor_name`, `hospital_name`, and doctor registration details. If you want to create a profile ahead of time, insert a row with the doctor's registered WhatsApp number:

```sql
INSERT INTO public.doctor_profiles
  (doctor_name, clinic_name, registration_number, specialty,
   qualification, clinic_address, clinic_city, clinic_phone, clinic_email,
   clinic_website, clinic_logo_url, doctor_phone, signature_image_url)
VALUES
  ('Dr. Sharma', 'City Hospital', 'STATE-MED-12345', 'General Medicine',
   'MBBS, MD', '12 Main Road', 'Bangalore', '+918080808080', 'frontdesk@example.com',
   'https://example.com', 'https://example.com/logo.png', '+919999000111',
   'https://example.com/signature.png');
```

The dashboard uses RLS, so doctors can only see visits linked to their claimed profile, matching doctor/clinic name, or their clinic when `is_clinic_admin = true`.
If a profile is missing optional prescription header fields, the dashboard falls back to the latest matching `hospital_boarding` row for that doctor and clinic.

## Deploy

Deploy the `doctor-dashboard/` folder as a static site through Vercel, Netlify, or any HTTPS static host.

## Workflow

1. Patient scans the QR and submits `patient-form`.
2. WF11 upserts `patients` and inserts a `patient_visits` row with `visit_status = waiting`.
3. Doctor signs in, opens the queue, adds optional visit context such as chief complaint, allergies, current medicines, conditions, vitals, and saves a draft prescription.
4. Doctor issues the prescription. The dashboard generates a PDF, uploads it to the private `prescriptions` Supabase Storage bucket, stores a signed URL, marks the visit completed, and invokes the secure Supabase Edge Function for WhatsApp delivery.
5. The prescription row stores `doctor_snapshot` and `clinic_snapshot`, so the PDF and patient prescription history keep the issuing doctor/clinic details even if the profile changes later.

## Prescription PDF Format

Issued PDFs use a prescription-pad layout:

- Clinic header with logo, clinic name, address, phone, email, and website
- Doctor block with name, qualification, specialty, registration number, and phone
- Prescription number, issue date/time, patient identity, patient code, visit date, allergies, and current medicines
- Diagnosis/remarks, medicine table, advice, follow-up date, and doctor signature/stamp area
- Footer note that the document was generated electronically

Logo and signature images are optional HTTPS URLs. If an image cannot be loaded because of CORS, network, or file type, the PDF falls back to text initials/signature labels instead of failing the prescription.

## UI and Performance Notes

- Open `index.html?demo=1` locally to review the full dashboard with sample data without touching Supabase.
- The prescription PDF library is lazy-loaded only when the doctor clicks issue, keeping the queue and consultation screen fast on first load.
- The QR patient form only captures identity and routing fields. Clinical context is owned by the doctor dashboard and written back to `patient_visits`.
- Patient matching uses the normalized WhatsApp phone number in `patients.phone`; `patient_visits.patient_id` links every visit back to that patient row.
- Repeat visits create new `patient_visits` rows for the same patient, and the dashboard shows previous visits plus prescription history for that `patient_id`.
- The UI uses skeleton queue loading, local filtering, responsive layout, and reduced-motion support for a smoother clinical workflow.
