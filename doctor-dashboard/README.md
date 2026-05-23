# Doctor Dashboard

Authenticated Supabase dashboard for the clinic/doctor queue and prescription workflow.

## Configure

Open `doctor-dashboard/index.html` and replace:

```js
const SUPABASE_URL = 'https://crsdccqseuhnimoxxeky.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
const PRESCRIPTION_WEBHOOK_URL = 'https://vaitalcare-production.up.railway.app/webhook/prescription-delivery';
```

`SUPABASE_ANON_KEY` must be copied from Supabase Project Settings -> API. WF13 must be imported and active before prescription WhatsApp delivery works.

## Doctor Accounts

1. Create a Supabase Auth user for each doctor.
2. Insert a matching `doctor_profiles` row:

```sql
INSERT INTO public.doctor_profiles
  (user_id, doctor_name, clinic_name, registration_number, specialty)
VALUES
  ('AUTH_USER_UUID', 'Dr. Sharma', 'City Hospital', 'STATE-MED-12345', 'General Medicine');
```

The dashboard uses RLS, so doctors can only see visits linked to their profile, matching doctor/clinic name, or their clinic when `is_clinic_admin = true`.

## Deploy

Deploy the `doctor-dashboard/` folder as a static site through Vercel, Netlify, or any HTTPS static host.

## Workflow

1. Patient scans the QR and submits `patient-form`.
2. WF11 upserts `patients` and inserts a `patient_visits` row with `visit_status = waiting`.
3. Doctor signs in, opens the queue, adds optional visit context such as chief complaint, allergies, current medicines, conditions, vitals, and saves a draft prescription.
4. Doctor issues the prescription. The dashboard generates a PDF, uploads it to the private `prescriptions` Supabase Storage bucket, stores a signed URL, marks the visit completed, and calls WF13 for WhatsApp delivery.

## UI and Performance Notes

- Open `index.html?demo=1` locally to review the full dashboard with sample data without touching Supabase.
- The prescription PDF library is lazy-loaded only when the doctor clicks issue, keeping the queue and consultation screen fast on first load.
- The QR patient form only captures identity and routing fields. Clinical context is owned by the doctor dashboard and written back to `patient_visits`.
- Patient matching uses the normalized WhatsApp phone number in `patients.phone`; `patient_visits.patient_id` links every visit back to that patient row.
- Repeat visits create new `patient_visits` rows for the same patient, and the dashboard shows previous visits plus prescription history for that `patient_id`.
- The UI uses skeleton queue loading, local filtering, responsive layout, and reduced-motion support for a smoother clinical workflow.
