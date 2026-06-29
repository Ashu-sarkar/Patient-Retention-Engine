#!/usr/bin/env node
/**
 * Seed Swastik Hospital for product demos.
 *
 * Quick mode (today's queue only):
 *   npm run seed:swastik-hospital
 *
 * Full demo (6-month history, follow-ups, retention analytics):
 *   npm run seed:swastik-demo
 *
 * Outputs dashboard + analytics login credentials and manifest in build/.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

function parseEnv(filePath) {
  try {
    return Object.fromEntries(
      fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(line => line.trim() && !line.trim().startsWith('#') && line.includes('='))
        .map(line => {
          const i = line.indexOf('=');
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

const env = { ...parseEnv(path.join(repoRoot, '.env')), ...process.env };

const SUPABASE_URL = (env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
const WEBHOOK_BASE = (env.WEBHOOK_URL || 'https://vaitalcare-production.up.railway.app').replace(/\/$/, '');

const HOSPITAL_NAME = process.env.SWASTIK_HOSPITAL || 'Swastik Hospital';
const FACILITY_TYPE = 'General Hospital';
const SEED_TAG = 'Swastik demo seed';
const FULL_DEMO = process.env.SWASTIK_FULL_DEMO === '1' || process.env.SWASTIK_FULL_DEMO === 'true';
const HISTORY_DAYS = Number(process.env.SWASTIK_HISTORY_DAYS || 365);
/** Realistic monthly OPD volume for a 2-doctor urban clinic (oldest → newest month). */
const MONTHLY_VISIT_TARGETS = [34, 37, 39, 36, 44, 47, 45, 51, 53, 56, 59, 62];
/** Target follow-up return rate at full adoption (~72%). */
const RETENTION_RETURN_RATE = 0.72;
/** Month-by-month retention curve — clinic adoption story (oldest → newest). */
const MONTHLY_RETENTION_TARGETS = [0.54, 0.57, 0.59, 0.61, 0.63, 0.65, 0.67, 0.69, 0.71, 0.73, 0.75, 0.77];

const DOCTORS = [
  {
    doctor_name: 'Dr. Vikram Swastik',
    doctor_qualification: 'MBBS, MD (General Medicine)',
    doctor_expertise: 'General Medicine — diabetes, hypertension, and primary care',
    doctor_registration_number: 'SWASTIK-REG-001',
    doctor_phone: '+919685722570',
    login_username: 'swastik.vikram',
    password: 'Swastik123',
  },
  {
    doctor_name: 'Dr. Ananya Reddy',
    doctor_qualification: 'MBBS, DNB (Pediatrics)',
    doctor_expertise: 'Pediatrics — child wellness and vaccinations',
    doctor_registration_number: 'SWASTIK-REG-002',
    doctor_phone: '+919179263530',
    login_username: 'swastik.ananya',
    password: 'Swastik123',
  },
];

const DUMMY_QUEUE = [
  {
    name: 'Ramesh Kumar',
    phone: '9810011101',
    dob: '1982-04-15',
    sex: 'Male',
    doctor_name: 'Dr. Vikram Swastik',
    chief_complaint: 'Fever and body ache for 2 days',
    visit_status: 'waiting',
  },
  {
    name: 'Sunita Devi',
    phone: '9810011102',
    dob: '1990-08-22',
    sex: 'Female',
    doctor_name: 'Dr. Vikram Swastik',
    chief_complaint: 'Persistent cough and sore throat',
    visit_status: 'waiting',
  },
  {
    name: 'Arjun Patel',
    phone: '9810011103',
    dob: '1975-11-03',
    sex: 'Male',
    doctor_name: 'Dr. Vikram Swastik',
    chief_complaint: 'Follow-up for blood pressure medicines',
    visit_status: 'in_consultation',
    symptoms_duration: '3 months on treatment',
    current_medicines: 'Amlodipine 5mg once daily',
  },
  {
    name: 'Meera Nair',
    phone: '9810011104',
    dob: '1988-01-09',
    sex: 'Female',
    doctor_name: 'Dr. Vikram Swastik',
    chief_complaint: 'Skin rash on arms',
    visit_status: 'completed',
    vitals_notes: 'BP 118/76, Temp 98.2°F',
  },
  {
    name: 'Kavitha Rao',
    phone: '9810011105',
    dob: '1995-06-30',
    sex: 'Female',
    doctor_name: 'Dr. Ananya Reddy',
    chief_complaint: 'Child vaccination due — 18 months',
    visit_status: 'waiting',
  },
  {
    name: 'Suresh Babu',
    phone: '9810011106',
    dob: '2019-12-05',
    sex: 'Male',
    doctor_name: 'Dr. Ananya Reddy',
    chief_complaint: 'Mild fever in toddler',
    visit_status: 'waiting',
    known_allergies: 'None known',
  },
  {
    name: 'Priya Sharma',
    phone: '9810011107',
    dob: '1992-03-18',
    sex: 'Female',
    doctor_name: 'Dr. Ananya Reddy',
    chief_complaint: 'Routine antenatal check-up',
    visit_status: 'in_consultation',
  },
];

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`✅ ${msg}`);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(isoDate, offset) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function daysAgoISO(offset) {
  return addDaysISO(todayISO(), -offset);
}

function isoAt(isoDate, hour = 10) {
  return new Date(`${isoDate}T${String(hour).padStart(2, '0')}:30:00+05:30`).toISOString();
}

const DEMO_NAMES = [
  { name: 'Ramesh Kumar', sex: 'Male', dob: '1982-04-15' },
  { name: 'Sunita Devi', sex: 'Female', dob: '1990-08-22' },
  { name: 'Arjun Patel', sex: 'Male', dob: '1975-11-03' },
  { name: 'Meera Nair', sex: 'Female', dob: '1988-01-09' },
  { name: 'Kavitha Rao', sex: 'Female', dob: '1995-06-30' },
  { name: 'Suresh Babu', sex: 'Male', dob: '2019-12-05' },
  { name: 'Priya Sharma', sex: 'Female', dob: '1992-03-18' },
  { name: 'Vikram Singh', sex: 'Male', dob: '1968-07-11' },
  { name: 'Lakshmi Iyer', sex: 'Female', dob: '1985-02-28' },
  { name: 'Rajesh Gupta', sex: 'Male', dob: '1979-09-14' },
  { name: 'Anita Desai', sex: 'Female', dob: '1993-12-01' },
  { name: 'Mohammed Farooq', sex: 'Male', dob: '1980-05-20' },
  { name: 'Deepa Menon', sex: 'Female', dob: '1987-10-08' },
  { name: 'Karthik Reddy', sex: 'Male', dob: '1998-03-25' },
  { name: 'Pooja Agarwal', sex: 'Female', dob: '1991-06-17' },
  { name: 'Sanjay Verma', sex: 'Male', dob: '1972-01-30' },
  { name: 'Nisha Thomas', sex: 'Female', dob: '1984-11-12' },
  { name: 'Harish Joshi', sex: 'Male', dob: '1965-08-05' },
  { name: 'Divya Krishnan', sex: 'Female', dob: '1996-04-09' },
  { name: 'Imran Khan', sex: 'Male', dob: '1989-07-22' },
  { name: 'Shalini Bose', sex: 'Female', dob: '1994-09-03' },
  { name: 'Gopal Naidu', sex: 'Male', dob: '1958-12-19' },
  { name: 'Rekha Pillai', sex: 'Female', dob: '1983-03-07' },
  { name: 'Amit Choudhury', sex: 'Male', dob: '1997-02-14' },
  { name: 'Fatima Sheikh', sex: 'Female', dob: '1990-10-27' },
  { name: 'Manoj Tiwari', sex: 'Male', dob: '1977-06-16' },
  { name: 'Sneha Kapoor', sex: 'Female', dob: '2001-01-08' },
  { name: 'Pradeep Malhotra', sex: 'Male', dob: '1963-05-02' },
  { name: 'Uma Hegde', sex: 'Female', dob: '1986-08-30' },
  { name: 'Rahul Saxena', sex: 'Male', dob: '1999-11-21' },
  { name: 'Geeta Murthy', sex: 'Female', dob: '1970-04-04' },
  { name: 'Naveen Kulkarni', sex: 'Male', dob: '1981-12-25' },
  { name: 'Padma Srinivasan', sex: 'Female', dob: '1974-07-18' },
  { name: 'Chetan Mehta', sex: 'Male', dob: '1988-02-03' },
  { name: 'Lalitha Gowda', sex: 'Female', dob: '1969-11-29' },
  { name: 'Bharat Shah', sex: 'Male', dob: '1976-05-14' },
  { name: 'Anjali Mishra', sex: 'Female', dob: '1993-08-07' },
  { name: 'Venkat Subramanian', sex: 'Male', dob: '1961-03-22' },
  { name: 'Swati Banerjee', sex: 'Female', dob: '1987-12-11' },
  { name: 'Rohit Deshmukh', sex: 'Male', dob: '1994-06-25' },
  { name: 'Kiran Bhat', sex: 'Female', dob: '1980-09-30' },
  { name: 'Murali Iyengar', sex: 'Male', dob: '1959-01-17' },
  { name: 'Tanvi Shah', sex: 'Female', dob: '2002-04-08' },
  { name: 'Aditya Khanna', sex: 'Male', dob: '1991-10-19' },
  { name: 'Revathi Nambiar', sex: 'Female', dob: '1985-07-04' },
  { name: 'Ganesh Prabhu', sex: 'Male', dob: '1973-02-28' },
  { name: 'Ishita Dutta', sex: 'Female', dob: '1998-11-15' },
  { name: 'Yusuf Ahmed', sex: 'Male', dob: '1984-08-21' },
  { name: 'Chitra Venkatesh', sex: 'Female', dob: '1971-05-09' },
  { name: 'Nitin Oberoi', sex: 'Male', dob: '1989-03-12' },
  { name: 'Sowmya Raghavan', sex: 'Female', dob: '1996-12-02' },
  { name: 'Harsh Vardhan', sex: 'Male', dob: '1967-06-26' },
  { name: 'Madhuri Kulkarni', sex: 'Female', dob: '1982-01-31' },
  { name: 'Prakash Shetty', sex: 'Male', dob: '1955-09-14' },
  { name: 'Neha Chawla', sex: 'Female', dob: '1999-07-23' },
  { name: 'Siddharth Rao', sex: 'Male', dob: '1992-04-17' },
  { name: 'Vandana Joshi', sex: 'Female', dob: '1978-10-05' },
  { name: 'Ashok Reddy', sex: 'Male', dob: '1964-08-28' },
  { name: 'Pallavi Sinha', sex: 'Female', dob: '1990-02-14' },
  { name: 'Kunal Agarwal', sex: 'Male', dob: '1986-11-30' },
  { name: 'Bhavana Hegde', sex: 'Female', dob: '1997-05-07' },
];

const CHRONIC_COMPLAINTS = new Set([
  'Blood pressure follow-up',
  'Diabetes review',
  'Thyroid review',
  'Migraine follow-up',
  'Follow-up for blood pressure medicines',
  'Joint pain — arthritis review',
  'Asthma inhaler review',
  'Cholesterol review',
]);

const COMPLAINTS = [
  'Fever and body ache',
  'Persistent cough',
  'Blood pressure follow-up',
  'Diabetes review',
  'Skin rash',
  'Child vaccination',
  'Routine antenatal check-up',
  'Joint pain',
  'Seasonal allergies',
  'Digestive discomfort',
  'Migraine follow-up',
  'Thyroid review',
  'Joint pain — arthritis review',
  'Asthma inhaler review',
  'Cholesterol review',
  'Child vaccination — 12 months',
  'Postpartum check-up',
];

async function sbFetch(endpoint, { method = 'GET', body, prefer } = {}) {
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { ok: res.ok, status: res.status, json };
}

async function getExistingBoarding() {
  const res = await sbFetch(
    `/rest/v1/hospital_boarding?hospital_name=eq.${encodeURIComponent(HOSPITAL_NAME)}&select=clinic_id,doctor_name,doctor_registration_number,auth_user_id,login_username&order=created_at.asc`,
  );
  if (!res.ok) fail(`Could not query hospital_boarding: ${JSON.stringify(res.json)}`);
  return Array.isArray(res.json) ? res.json : [];
}

async function boardHospital() {
  const primary = DOCTORS[0];
  const payload = {
    hospital_name: HOSPITAL_NAME,
    facility_type: FACILITY_TYPE,
    address: '45 MG Road, Near City Bus Stand, Bengaluru, Karnataka 560001',
    city: 'Bengaluru',
    contact_phone: '9685722570',
    admin_contact_name: 'Swastik Hospital Admin',
    clinic_logo_url: '',
    clinic_email: 'frontdesk@swastikhospital.demo',
    clinic_website: 'https://swastikhospital.demo',
    consultation_hours: 'Mon–Sat 9:00 AM – 9:00 PM, Sun 10:00 AM – 2:00 PM',
    doctor_count: String(DOCTORS.length),
    doctors_json: JSON.stringify(DOCTORS),
    doctor_name: primary.doctor_name,
    doctor_qualification: primary.doctor_qualification,
    doctor_expertise: primary.doctor_expertise,
    doctor_registration_number: primary.doctor_registration_number,
    doctor_phone: primary.doctor_phone,
    doctor_signature_url: '',
    login_username: primary.login_username,
  };

  const form = new URLSearchParams(payload).toString();
  const res = await fetch(`${WEBHOOK_BASE}/webhook/hospital-boarding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  if (res.ok && json?.status === 'success') return { via: 'wf12', json };

  console.warn(`⚠️  WF12 unavailable (${res.status}) — seeding hospital rows directly`);
  return seedHospitalDirect();
}

async function seedHospitalDirect() {
  const slug = HOSPITAL_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  let clinicRes = await sbFetch(`/rest/v1/clinics?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`);
  let clinicId = Array.isArray(clinicRes.json) ? clinicRes.json[0]?.id : null;

  if (!clinicId) {
    const code = `SWASTIK${Date.now().toString(36).slice(-4).toUpperCase()}`;
    clinicRes = await sbFetch('/rest/v1/clinics', {
      method: 'POST',
      prefer: 'return=representation',
      body: { name: HOSPITAL_NAME, slug, code, status: 'active' },
    });
    clinicId = Array.isArray(clinicRes.json) ? clinicRes.json[0]?.id : clinicRes.json?.id;
  }
  if (!clinicId) fail('Could not resolve clinic_id');

  for (const doctor of DOCTORS) {
    const existing = await sbFetch(
      `/rest/v1/hospital_boarding?clinic_id=eq.${clinicId}&doctor_registration_number=eq.${encodeURIComponent(doctor.doctor_registration_number)}&select=id&limit=1`,
    );
    if (Array.isArray(existing.json) && existing.json.length > 0) continue;

    const ins = await sbFetch('/rest/v1/hospital_boarding', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        clinic_id: clinicId,
        hospital_name: HOSPITAL_NAME,
        facility_type: FACILITY_TYPE,
        address: '45 MG Road, Near City Bus Stand, Bengaluru, Karnataka 560001',
        city: 'Bengaluru',
        contact_phone: '9685722570',
        admin_contact_name: 'Swastik Hospital Admin',
        doctor_name: doctor.doctor_name,
        doctor_qualification: doctor.doctor_qualification,
        doctor_expertise: doctor.doctor_expertise,
        doctor_registration_number: doctor.doctor_registration_number,
        doctor_phone: doctor.doctor_phone,
        login_username: doctor.login_username,
        consultation_hours: 'Mon–Sat 9:00 AM – 9:00 PM',
      },
    });
    if (!ins.ok) fail(`boarding insert failed for ${doctor.doctor_name}: ${JSON.stringify(ins.json)}`);
  }

  return { via: 'direct', clinicId };
}

async function getDoctorProfiles(clinicId) {
  const res = await sbFetch(
    `/rest/v1/doctor_profiles?clinic_id=eq.${clinicId}&select=id,doctor_name,login_username,clinic_name,clinic_id,user_id,is_clinic_admin`,
  );
  if (!res.ok) fail(`doctor_profiles query failed: ${JSON.stringify(res.json)}`);
  return Array.isArray(res.json) ? res.json : [];
}

async function upsertClinicMembership(clinicId, userId, doctorProfileId, role) {
  const existing = await sbFetch(
    `/rest/v1/clinic_memberships?clinic_id=eq.${clinicId}&user_id=eq.${userId}&role=eq.${encodeURIComponent(role)}&select=id&limit=1`,
  );
  if (Array.isArray(existing.json) && existing.json.length > 0) {
    await sbFetch(`/rest/v1/clinic_memberships?id=eq.${existing.json[0].id}`, {
      method: 'PATCH',
      body: { doctor_profile_id: doctorProfileId, status: 'active' },
    });
    return;
  }
  await sbFetch('/rest/v1/clinic_memberships', {
    method: 'POST',
    body: {
      clinic_id: clinicId,
      user_id: userId,
      doctor_profile_id: doctorProfileId,
      role,
      status: 'active',
    },
  });
}

/** Analytics RPCs require active clinic_memberships — WF12 does not always backfill them. */
async function ensureClinicMemberships(clinicId, profiles, boardingRows) {
  const profileByUser = Object.fromEntries(
    profiles.filter(p => p.user_id).map(p => [p.user_id, p]),
  );
  let synced = 0;

  for (const row of boardingRows) {
    const userId = row.auth_user_id;
    if (!userId) continue;
    const profile = profileByUser[userId] || profiles.find(p => p.login_username === row.login_username);
    if (!profile?.id) continue;
    await upsertClinicMembership(clinicId, userId, profile.id, 'doctor');
    synced += 1;
    if (profile.is_clinic_admin || profile.login_username === 'swastik.vikram') {
      await upsertClinicMembership(clinicId, userId, profile.id, 'clinic_admin');
    }
  }

  for (const profile of profiles) {
    if (!profile.user_id || profileByUser[profile.user_id]) continue;
    await upsertClinicMembership(clinicId, profile.user_id, profile.id, 'doctor');
    synced += 1;
    if (profile.is_clinic_admin) {
      await upsertClinicMembership(clinicId, profile.user_id, profile.id, 'clinic_admin');
    }
  }

  if (synced > 0) ok(`Synced ${synced} doctor clinic_membership(s) for analytics access`);
  else console.warn('⚠️  No clinic_memberships synced — boarding rows may lack auth_user_id');
}

async function ensureDoctorProfilesFromBoarding(clinicId) {
  const res = await sbFetch(
    `/rest/v1/hospital_boarding?clinic_id=eq.${clinicId}&select=*&order=created_at.asc`,
  );
  if (!res.ok) return [];
  const rows = Array.isArray(res.json) ? res.json : [];
  for (const row of rows) {
    if (!row.auth_user_id) continue;
    const existing = await sbFetch(
      `/rest/v1/doctor_profiles?user_id=eq.${row.auth_user_id}&select=id&limit=1`,
    );
    if (Array.isArray(existing.json) && existing.json.length > 0) continue;

    const ins = await sbFetch('/rest/v1/doctor_profiles', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        clinic_id: row.clinic_id,
        user_id: row.auth_user_id,
        doctor_name: row.doctor_name,
        clinic_name: row.hospital_name,
        registration_number: row.doctor_registration_number || `SWASTIK-${String(row.id).slice(0, 8)}`,
        specialty: row.doctor_expertise,
        qualification: row.doctor_qualification,
        clinic_address: row.address,
        clinic_city: row.city,
        clinic_phone: row.contact_phone,
        clinic_email: row.clinic_email,
        clinic_website: row.clinic_website,
        clinic_logo_url: row.clinic_logo_url,
        doctor_phone: row.doctor_phone,
        login_username: row.login_username,
        signature_image_url: row.doctor_signature_url,
        signature_label: row.doctor_name,
        stamp_label: row.doctor_registration_number || 'Swastik Hospital',
      },
    });
    if (!ins.ok) {
      console.warn(`⚠️  doctor_profiles insert skipped for ${row.doctor_name}: ${JSON.stringify(ins.json).slice(0, 120)}`);
    }
  }
  return getDoctorProfiles(clinicId);
}

async function nextPatientCode(clinicId) {
  const res = await sbFetch('/rest/v1/rpc/next_patient_code', {
    method: 'POST',
    body: { p_clinic_id: clinicId },
  });
  if (!res.ok) fail(`next_patient_code failed: ${JSON.stringify(res.json)}`);
  return res.json;
}

async function cleanupPriorSeed(clinicId) {
  const patientsRes = await sbFetch(
    `/rest/v1/patients?clinic_id=eq.${clinicId}&notes=eq.${encodeURIComponent(SEED_TAG)}&select=id`,
  );
  const patients = Array.isArray(patientsRes.json) ? patientsRes.json : [];
  for (const row of patients) {
    await sbFetch(`/rest/v1/message_logs?patient_id=eq.${row.id}`, { method: 'DELETE' });
    const rxRes = await sbFetch(`/rest/v1/prescriptions?patient_id=eq.${row.id}&select=id`);
    const rxRows = Array.isArray(rxRes.json) ? rxRes.json : [];
    for (const rx of rxRows) {
      await sbFetch(`/rest/v1/prescription_medicines?prescription_id=eq.${rx.id}`, { method: 'DELETE' });
      await sbFetch(`/rest/v1/prescriptions?id=eq.${rx.id}`, { method: 'DELETE' });
    }
    await sbFetch(`/rest/v1/patient_visits?patient_id=eq.${row.id}`, { method: 'DELETE' });
    await sbFetch(`/rest/v1/patients?id=eq.${row.id}`, { method: 'DELETE' });
  }
  if (patients.length) ok(`Removed ${patients.length} prior demo patient(s) and related records`);
}

async function upsertPatient(clinicId, row) {
  const phoneE164 = `+91${row.phone}`;
  const existing = await sbFetch(
    `/rest/v1/patients?clinic_id=eq.${clinicId}&phone=eq.${encodeURIComponent(phoneE164)}&select=id,patient_code&limit=1`,
  );
  const found = Array.isArray(existing.json) ? existing.json[0] : null;
  if (found?.id) {
    await sbFetch(`/rest/v1/patients?id=eq.${found.id}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: {
        name: row.name,
        dob: row.dob,
        sex: row.sex,
        doctor_name: row.doctor_name,
        clinic_name: HOSPITAL_NAME,
        visit_date: todayISO(),
        notes: SEED_TAG,
      },
    });
    return { id: found.id, patient_code: found.patient_code, phone: phoneE164 };
  }

  const patientCode = await nextPatientCode(clinicId);
  const ins = await sbFetch('/rest/v1/patients', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      clinic_id: clinicId,
      patient_code: patientCode,
      name: row.name,
      phone: phoneE164,
      dob: row.dob,
      sex: row.sex,
      clinic_name: HOSPITAL_NAME,
      doctor_name: row.doctor_name,
      visit_date: todayISO(),
      follow_up_required: 'No',
      status: 'pending',
      message_count: 0,
      notes: SEED_TAG,
    },
  });
  if (!ins.ok) fail(`patient insert failed for ${row.name}: ${JSON.stringify(ins.json)}`);
  const patient = Array.isArray(ins.json) ? ins.json[0] : ins.json;
  return { id: patient.id, patient_code: patient.patient_code, phone: phoneE164 };
}

async function createVisit(clinicId, patient, row, doctorProfileId, visitDate = todayISO()) {
  const existing = await sbFetch(
    `/rest/v1/patient_visits?patient_id=eq.${patient.id}&visit_date=eq.${visitDate}&visit_status=not.in.(cancelled,no_show)&select=id&limit=1`,
  );
  if (Array.isArray(existing.json) && existing.json.length > 0) {
    await sbFetch(`/rest/v1/patient_visits?id=eq.${existing.json[0].id}`, {
      method: 'PATCH',
      body: {
        visit_status: row.visit_status,
        chief_complaint: row.chief_complaint,
        symptoms_duration: row.symptoms_duration || null,
        current_medicines: row.current_medicines || null,
        known_allergies: row.known_allergies || null,
        vitals_notes: row.vitals_notes || null,
        doctor_name: row.doctor_name,
        clinic_name: HOSPITAL_NAME,
      },
    });
    return existing.json[0].id;
  }

  const body = {
    clinic_id: clinicId,
    patient_id: patient.id,
    doctor_profile_id: doctorProfileId || null,
    patient_code: patient.patient_code,
    clinic_name: HOSPITAL_NAME,
    doctor_name: row.doctor_name,
    visit_date: visitDate,
    visit_status: row.visit_status,
    chief_complaint: row.chief_complaint,
    symptoms_duration: row.symptoms_duration || null,
    current_medicines: row.current_medicines || null,
    known_allergies: row.known_allergies || null,
    vitals_notes: row.vitals_notes || null,
    staff_notes: SEED_TAG,
    checked_in_at: isoAt(visitDate, row.visit_status === 'waiting' ? 9 : 11),
  };
  if (row.visit_status === 'in_consultation') {
    body.consultation_started_at = isoAt(visitDate, 11);
  }
  if (row.visit_status === 'completed') {
    body.consultation_started_at = isoAt(visitDate, 10);
    body.completed_at = isoAt(visitDate, 10);
  }

  const ins = await sbFetch('/rest/v1/patient_visits', {
    method: 'POST',
    prefer: 'return=representation',
    body,
  });
  if (!ins.ok) fail(`visit insert failed for ${row.name} on ${visitDate}: ${JSON.stringify(ins.json)}`);
  const visit = Array.isArray(ins.json) ? ins.json[0] : ins.json;
  return visit.id;
}

async function seedDummyQueue(clinicId, profiles) {
  const profileByName = Object.fromEntries(profiles.map(p => [p.doctor_name, p.id]));
  let created = 0;

  for (const row of DUMMY_QUEUE) {
    const patient = await upsertPatient(clinicId, row);
    const doctorProfileId = profileByName[row.doctor_name] || null;
    await createVisit(clinicId, patient, row, doctorProfileId);
    created++;
  }

  return created;
}

function seededRand(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function monthKey(isoDate) {
  return isoDate.slice(0, 7);
}

function listMonthStarts(monthCount = 12) {
  const today = new Date();
  const anchor = new Date(today.getFullYear(), today.getMonth(), 1);
  const months = [];
  for (let i = monthCount - 1; i >= 0; i -= 1) {
    const d = new Date(anchor);
    d.setMonth(d.getMonth() - i);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

function weekdaysInMonth(ym, maxDate = todayISO()) {
  const [year, month] = ym.split('-').map(Number);
  const days = [];
  for (let day = 1; day <= 31; day += 1) {
    const iso = `${ym}-${String(day).padStart(2, '0')}`;
    const dt = new Date(`${iso}T12:00:00`);
    if (dt.getFullYear() !== year || dt.getMonth() + 1 !== month) break;
    if (dt.getDay() === 0) continue;
    if (iso > maxDate) continue;
    days.push(iso);
  }
  return days;
}

function spreadVisitsAcrossMonth(ym, count, rand) {
  const weekdays = weekdaysInMonth(ym);
  if (!weekdays.length || count <= 0) return [];
  const slots = [];
  for (let i = 0; i < count; i += 1) {
    slots.push(weekdays[Math.floor(rand() * weekdays.length)]);
  }
  slots.sort();
  return slots;
}

function buildPatientPool() {
  return DEMO_NAMES.map((person, index) => {
    const queueMatch = DUMMY_QUEUE.find(q => q.name === person.name);
    const isPediatric = queueMatch?.doctor_name === 'Dr. Ananya Reddy' || index % 4 === 0;
    const doctorName = queueMatch?.doctor_name || (isPediatric ? 'Dr. Ananya Reddy' : 'Dr. Vikram Swastik');
    return {
      ...person,
      index,
      phone: queueMatch?.phone || `98102${String(1000 + index).padStart(4, '0')}`,
      doctor_name: doctorName,
      chief_complaint: queueMatch?.chief_complaint || COMPLAINTS[index % COMPLAINTS.length],
      visit_status: queueMatch?.visit_status || 'completed',
      symptoms_duration: queueMatch?.symptoms_duration || null,
      current_medicines: queueMatch?.current_medicines || null,
      known_allergies: queueMatch?.known_allergies || null,
      vitals_notes: queueMatch?.vitals_notes || null,
      in_today_queue: Boolean(queueMatch),
    };
  });
}

function pickComplaint(rand, doctorName, visitIndex) {
  if (doctorName === 'Dr. Ananya Reddy') {
    const pediatric = [
      'Child vaccination — 12 months',
      'Mild fever in toddler',
      'Child vaccination due — 18 months',
      'Routine antenatal check-up',
      'Seasonal allergies',
    ];
    return pediatric[Math.floor(rand() * pediatric.length)];
  }
  if (visitIndex > 0 && rand() < 0.58) {
    const chronic = [...CHRONIC_COMPLAINTS];
    return chronic[Math.floor(rand() * chronic.length)];
  }
  const acute = [
    'Fever and body ache for 2 days',
    'Persistent cough and sore throat',
    'Skin rash on arms',
    'Digestive discomfort',
    'Seasonal allergies',
    'Upper respiratory infection',
  ];
  return acute[Math.floor(rand() * acute.length)];
}

function isChronicComplaint(complaint) {
  return CHRONIC_COMPLAINTS.has(complaint)
    || /follow-up|review|diabetes|pressure|thyroid|arthritis|asthma|cholesterol/i.test(complaint);
}

async function patchPatient(clinicId, patientId, patch) {
  await sbFetch(`/rest/v1/patients?id=eq.${patientId}`, {
    method: 'PATCH',
    body: { clinic_id: clinicId, ...patch },
  });
}

async function seedPrescription(clinicId, patient, visitId, doctorProfileId, doctorName, opts = {}) {
  const followUpDate = opts.followUpDate || addDaysISO(todayISO(), 14);
  const issuedAt = opts.issuedAt || new Date().toISOString();
  const ins = await sbFetch('/rest/v1/prescriptions', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      clinic_id: clinicId,
      patient_id: patient.id,
      ...(visitId ? { visit_id: visitId } : {}),
      doctor_profile_id: doctorProfileId,
      status: 'issued',
      diagnosis: opts.diagnosis || 'Stable on current treatment — continue medicines',
      clinical_remarks: opts.chief_complaint || patient.chief_complaint || 'Routine review',
      advice: 'Take medicines on time. Walk 30 minutes daily. Return if symptoms worsen.',
      follow_up_required: 'Yes',
      follow_up_date: followUpDate,
      issued_at: issuedAt,
      delivery_status: 'sent',
      pdf_url: 'https://example.com/swastik-demo-rx.pdf',
      doctor_snapshot: { name: doctorName },
      clinic_snapshot: { name: HOSPITAL_NAME },
    },
  });
  if (!ins.ok) return null;
  const rx = Array.isArray(ins.json) ? ins.json[0] : ins.json;
  await sbFetch('/rest/v1/prescription_medicines', {
    method: 'POST',
    body: [{
      prescription_id: rx.id,
      clinic_id: clinicId,
      medicine_name: 'Paracetamol 500mg',
      dosage: '1 tablet',
      frequency: 'TDS',
      timing: 'After meals',
      duration: '5 days',
      sort_order: 1,
    }],
  });
  return rx.id;
}

async function seedMessageLog(clinicId, patient, messageType, scheduledDate) {
  await sbFetch('/rest/v1/message_logs', {
    method: 'POST',
    body: {
      clinic_id: clinicId,
      patient_id: patient.id,
      patient_name: patient.name,
      phone: patient.phone,
      workflow_name: 'swastik-demo-seed',
      message_type: messageType,
      message_sent: `Demo ${messageType} for ${patient.name}`,
      sent_at: isoAt(scheduledDate, 9),
      scheduled_date: scheduledDate,
      delivery_status: 'sent',
      provider_message_id: `DEMO${String(Math.random()).slice(2, 14)}`,
      twilio_message_sid: `DEMO${String(Math.random()).slice(2, 14)}`,
    },
  });
}

async function verifyAnalyticsData(clinicId) {
  const visitsRes = await fetch(`${SUPABASE_URL}/rest/v1/patient_visits?clinic_id=eq.${clinicId}&select=id`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: 'count=exact',
    },
  });
  const visitRange = visitsRes.headers.get('content-range') || '0';
  const visitTotal = Number(visitRange.split('/')[1] || 0);

  const membershipsRes = await sbFetch(
    `/rest/v1/clinic_memberships?clinic_id=eq.${clinicId}&status=eq.active&select=id,role,user_id`,
  );
  const memberships = Array.isArray(membershipsRes.json) ? membershipsRes.json : [];

  const rollupRes = await fetch(`${SUPABASE_URL}/rest/v1/clinic_daily_analytics?clinic_id=eq.${clinicId}&select=metric_date`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: 'count=exact',
    },
  });
  const rollupRange = rollupRes.headers.get('content-range') || '0';
  const rollupTotal = Number(rollupRange.split('/')[1] || 0);

  ok(`Analytics readiness: ${visitTotal} visits · ${rollupTotal} daily rollup rows · ${memberships.length} active membership(s)`);
  if (visitTotal < 50) {
    console.warn('⚠️  Low visit count — run npm run seed:swastik-demo for full 12-month history');
  }
  if (memberships.length === 0) {
    console.warn('⚠️  No clinic_memberships — doctors will see empty analytics until memberships exist');
  }
  return { visitTotal, rollupTotal, memberships: memberships.length };
}

async function refreshAnalyticsRollups(days = HISTORY_DAYS) {
  let refreshed = 0;
  for (let offset = days; offset >= 0; offset -= 1) {
    const metricDate = daysAgoISO(offset);
    const res = await sbFetch('/rest/v1/rpc/refresh_clinic_daily_analytics', {
      method: 'POST',
      body: { p_metric_date: metricDate },
    });
    if (res.ok) refreshed += 1;
  }
  ok(`Refreshed clinic_daily_analytics for ${refreshed} day(s)`);
}

async function seedFullDemo(clinicId, profiles) {
  const profileByName = Object.fromEntries(profiles.map(p => [p.doctor_name, p.id]));
  const pool = buildPatientPool();
  const rand = seededRand(0x53415354); // "SAST"
  const today = todayISO();
  const patientDb = new Map();
  const visitHistory = new Map();
  let visitCount = 0;
  let prescriptionCount = 0;
  let messageCount = 0;
  let followUpScheduled = 0;
  let followUpReturned = 0;

  for (const row of pool) {
    const patient = await upsertPatient(clinicId, row);
    patientDb.set(row.index, { ...row, ...patient });
    visitHistory.set(patient.id, []);
  }

  const months = listMonthStarts(MONTHLY_VISIT_TARGETS.length);
  let patientCursor = 0;

  for (let m = 0; m < months.length; m += 1) {
    const ym = months[m];
    const target = MONTHLY_VISIT_TARGETS[m] || 40;
    const visitDates = spreadVisitsAcrossMonth(ym, target, rand);
    const monthRetention = MONTHLY_RETENTION_TARGETS[m] ?? RETENTION_RETURN_RATE;
    const chronicBoost = 0.42 + (m / Math.max(months.length - 1, 1)) * 0.22;

    for (const visitDate of visitDates) {
      const row = pool[patientCursor % pool.length];
      patientCursor += 1;
      const patient = patientDb.get(row.index);
      const priorVisits = visitHistory.get(patient.id) || [];
      const doctorName = row.doctor_name;
      const doctorProfileId = profileByName[doctorName] || null;
      const complaint = pickComplaint(rand, doctorName, priorVisits.length);
      const isToday = visitDate === today;
      const visitStatus = isToday && row.in_today_queue
        ? row.visit_status
        : (rand() < 0.93 ? 'completed' : 'in_consultation');

      const visitId = await createVisit(
        clinicId,
        patient,
        { ...row, chief_complaint: complaint, visit_status: visitStatus },
        doctorProfileId,
        visitDate,
      );
      visitCount += 1;
      priorVisits.push({ visitDate, visitId, complaint, doctorName, doctorProfileId });
      visitHistory.set(patient.id, priorVisits);

      if (visitStatus === 'completed' && visitDate < today) {
        const treatAsChronic = isChronicComplaint(complaint)
          || (priorVisits.length > 0 && rand() < chronicBoost);
        if (!treatAsChronic) continue;

        const followUpDate = addDaysISO(visitDate, 14 + Math.floor(rand() * 7));
        if (followUpDate <= today) {
          followUpScheduled += 1;
          const returned = rand() < monthRetention;
          const returnDate = returned
            ? addDaysISO(followUpDate, 2 + Math.floor(rand() * 9))
            : null;

          await seedPrescription(clinicId, patient, visitId, doctorProfileId, doctorName, {
            followUpDate,
            issuedAt: isoAt(visitDate, 11),
            chief_complaint: complaint,
            diagnosis: complaint.includes('Diabetes')
              ? 'Type 2 diabetes — HbA1c stable at 7.1%'
              : complaint.includes('pressure') || complaint.includes('Pressure')
                ? 'Hypertension — BP 128/82 on medication'
                : 'Responding well to treatment',
          });
          prescriptionCount += 1;

          if (returned && returnDate && returnDate <= today) {
            followUpReturned += 1;
            await createVisit(
              clinicId,
              patient,
              {
                ...row,
                chief_complaint: `${complaint} — follow-up visit`,
                visit_status: 'completed',
              },
              doctorProfileId,
              returnDate,
            );
            visitCount += 1;
            await patchPatient(clinicId, patient.id, {
              follow_up_required: 'Yes',
              follow_up_date: followUpDate,
              status: 'completed',
              doctor_name: doctorName,
            });
            await seedMessageLog(
              clinicId,
              { ...patient, phone: `+91${row.phone}` },
              'follow_up_reminder',
              addDaysISO(followUpDate, -1),
            );
            messageCount += 1;
          } else if (!returned) {
            await patchPatient(clinicId, patient.id, {
              follow_up_required: 'Yes',
              follow_up_date: followUpDate,
              status: 'missed',
              doctor_name: doctorName,
            });
            await seedMessageLog(
              clinicId,
              { ...patient, phone: `+91${row.phone}` },
              'follow_up_reminder',
              addDaysISO(followUpDate, -2),
            );
            messageCount += 1;
          }
        }
      }
    }
  }

  // Today's live queue — ensure all 7 reception patients are present with realistic statuses
  for (const row of pool.filter(p => p.in_today_queue)) {
    const patient = patientDb.get(row.index);
    const doctorProfileId = profileByName[row.doctor_name] || null;
    const existing = await sbFetch(
      `/rest/v1/patient_visits?patient_id=eq.${patient.id}&visit_date=eq.${today}&visit_status=not.in.(cancelled,no_show)&select=id&limit=1`,
    );
    if (!Array.isArray(existing.json) || existing.json.length === 0) {
      await createVisit(clinicId, patient, row, doctorProfileId, today);
      visitCount += 1;
    } else {
      await sbFetch(`/rest/v1/patient_visits?id=eq.${existing.json[0].id}`, {
        method: 'PATCH',
        body: {
          visit_status: row.visit_status,
          chief_complaint: row.chief_complaint,
          doctor_name: row.doctor_name,
        },
      });
    }
  }

  // Active pipeline: due today, upcoming, and a handful overdue (believable for a busy clinic)
  const pipelinePatients = pool.filter(p => !p.in_today_queue).slice(0, 18);
  for (let i = 0; i < pipelinePatients.length; i += 1) {
    const row = pipelinePatients[i];
    const patient = patientDb.get(row.index);
    const doctorProfileId = profileByName[row.doctor_name] || null;
    if (i < 4) {
      await patchPatient(clinicId, patient.id, {
        follow_up_required: 'Yes',
        follow_up_date: today,
        status: 'pending',
        doctor_name: row.doctor_name,
      });
    } else if (i < 10) {
      await patchPatient(clinicId, patient.id, {
        follow_up_required: 'Yes',
        follow_up_date: addDaysISO(today, 4 + (i % 12)),
        status: 'pending',
        doctor_name: row.doctor_name,
      });
    } else if (i < 14) {
      const overdueDate = daysAgoISO(5 + (i % 9));
      await patchPatient(clinicId, patient.id, {
        follow_up_required: 'Yes',
        follow_up_date: overdueDate,
        status: 'missed',
        doctor_name: row.doctor_name,
      });
      await seedPrescription(clinicId, patient, null, doctorProfileId, row.doctor_name, {
        followUpDate: overdueDate,
        issuedAt: isoAt(daysAgoISO(20 + i), 10),
        chief_complaint: 'Blood pressure follow-up',
      }).catch(() => {});
      prescriptionCount += 1;
    }
  }

  await refreshAnalyticsRollups(HISTORY_DAYS);

  const retentionPct = followUpScheduled
    ? Math.round((followUpReturned / followUpScheduled) * 1000) / 10
    : 0;

  return {
    patients: pool.length,
    visitCount,
    prescriptionCount,
    messageCount,
    followUpScheduled,
    followUpReturned,
    retentionPct,
    monthsCovered: months.length,
  };
}

function saveManifest({ clinicId, profiles, visitCount, stats = {} }) {
  const buildDir = path.join(repoRoot, 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  const manifest = {
    hospital_name: HOSPITAL_NAME,
    clinic_id: clinicId,
    visit_date: todayISO(),
    mode: FULL_DEMO ? 'full_demo' : 'today_queue',
    visits_seeded: visitCount,
    patients_seeded: stats.patients || DUMMY_QUEUE.length,
    prescriptions_seeded: stats.prescriptionCount || 0,
    message_logs_seeded: stats.messageCount || 0,
    history_days: FULL_DEMO ? HISTORY_DAYS : 0,
    months_covered: stats.monthsCovered || 0,
    modeled_retention_pct: stats.retentionPct || null,
    follow_ups_scheduled: stats.followUpScheduled || 0,
    follow_ups_returned: stats.followUpReturned || 0,
    doctors: DOCTORS.map(d => ({
      name: d.doctor_name,
      username: d.login_username,
      password: d.password,
    })),
    dashboard_url: process.env.DOCTOR_DASHBOARD_URL || 'https://vaitalcare-doctor.vercel.app',
    analytics_url: process.env.DOCTOR_ANALYTICS_URL || 'https://vaitalcare-doctor-analytics.vercel.app',
    demo_tips: FULL_DEMO ? [
      'Doctor dashboard: sign in as swastik.vikram — today\'s queue is pre-filled.',
      'Analytics: open with Last 6 months or Last 12 months — visits grow month-on-month, retention improves over time.',
      `Modeled chronic-care retention: ~${stats.retentionPct || 72}% overall; early months ~54%, recent months ~77%.`,
      'Compare Dr. Vikram vs Dr. Ananya using the doctor filter — pediatric vs general medicine mix.',
    ] : ['Today\'s queue only — run npm run seed:swastik-demo for full analytics history.'],
    created_at: new Date().toISOString(),
  };
  const manifestPath = path.join(buildDir, 'swastik-hospital-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env');
  }

  console.log(`\n── Swastik Hospital ${FULL_DEMO ? 'full demo' : 'queue'} seed ──\n`);

  let boardingRows = await getExistingBoarding();
  if (boardingRows.length >= DOCTORS.length) {
    ok(`Hospital already onboarded (${boardingRows.length} doctor row(s))`);
  } else {
    console.log('Boarding Swastik Hospital…');
    await boardHospital();
    await new Promise(r => setTimeout(r, 2000));
    boardingRows = await getExistingBoarding();
    if (boardingRows.length === 0) fail('Boarding finished but no hospital_boarding rows found');
    ok(`Onboarded ${boardingRows.length} doctor(s)`);
  }

  const clinicId = boardingRows[0]?.clinic_id;
  if (!clinicId) fail('Could not resolve clinic_id');

  let profiles = await ensureDoctorProfilesFromBoarding(clinicId);
  if (profiles.length === 0) {
    console.warn('⚠️  No doctor_profiles yet — visits will seed without doctor_profile_id');
  } else {
    ok(`${profiles.length} doctor profile(s) ready`);
    const vikram = profiles.find(p => p.login_username === 'swastik.vikram');
    if (vikram?.id) {
      await sbFetch(`/rest/v1/doctor_profiles?id=eq.${vikram.id}`, {
        method: 'PATCH',
        body: { is_clinic_admin: true },
      });
      vikram.is_clinic_admin = true;
    }
    profiles = await getDoctorProfiles(clinicId);
    await ensureClinicMemberships(clinicId, profiles, boardingRows);
  }

  await cleanupPriorSeed(clinicId);

  let visitCount;
  let stats = {};
  if (FULL_DEMO) {
    stats = await seedFullDemo(clinicId, profiles);
    visitCount = stats.visitCount;
    ok(`Seeded ${stats.patients} patients · ${visitCount} visits over ${stats.monthsCovered} months · ${stats.prescriptionCount} prescriptions`);
    console.log(`   Retention story: ${stats.followUpReturned}/${stats.followUpScheduled} chronic follow-ups returned (~${stats.retentionPct}%)`);
    console.log(`   Message trail: ${stats.messageCount} WhatsApp reminders logged`);
  } else {
    visitCount = await seedDummyQueue(clinicId, profiles);
    ok(`Seeded ${visitCount} dummy queue visits for ${todayISO()}`);
    const waiting = DUMMY_QUEUE.filter(r => r.visit_status === 'waiting').length;
    const consult = DUMMY_QUEUE.filter(r => r.visit_status === 'in_consultation').length;
    const done = DUMMY_QUEUE.filter(r => r.visit_status === 'completed').length;
    console.log(`   Queue mix: ${waiting} waiting · ${consult} in consultation · ${done} completed`);
  }

  const manifestPath = saveManifest({ clinicId, profiles, visitCount, stats });
  ok(`Manifest saved to ${manifestPath}`);

  await verifyAnalyticsData(clinicId);

  console.log('\n── Doctor dashboard logins ──');
  console.log(`   Dashboard : ${process.env.DOCTOR_DASHBOARD_URL || 'https://vaitalcare-doctor.vercel.app'}`);
  console.log(`   Analytics : ${process.env.DOCTOR_ANALYTICS_URL || 'https://vaitalcare-doctor-analytics.vercel.app'}`);
  for (const d of DOCTORS) {
    console.log(`   ${d.doctor_name}`);
    console.log(`     username: ${d.login_username}`);
    console.log(`     password: ${d.password}`);
  }

  if (FULL_DEMO) {
    console.log('\n── Demo walkthrough ──');
    console.log('   1. Doctor dashboard → today\'s queue, issue a prescription');
    console.log('   2. Analytics → Last 6 months or Last 12 months preset');
    console.log('   3. Point to monthly visits growth, rising retention curve, overdue follow-ups list');
  }

  console.log(`\n[seed-swastik-hospital] Done.${FULL_DEMO ? ' Open analytics for retention charts.' : ''}\n`);
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
