#!/usr/bin/env node
/**
 * Seed Swastik Hospital with dummy patients + today's queue for the doctor dashboard.
 *
 * Usage:
 *   node scripts/seed-swastik-hospital.mjs
 *   npm run seed:swastik-hospital
 *
 * Outputs dashboard login credentials and visit counts.
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
    `/rest/v1/hospital_boarding?hospital_name=eq.${encodeURIComponent(HOSPITAL_NAME)}&select=clinic_id,doctor_name,doctor_registration_number&order=created_at.asc`,
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
    `/rest/v1/doctor_profiles?clinic_id=eq.${clinicId}&select=id,doctor_name,login_username,clinic_name,clinic_id`,
  );
  if (!res.ok) fail(`doctor_profiles query failed: ${JSON.stringify(res.json)}`);
  return Array.isArray(res.json) ? res.json : [];
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
    await sbFetch(`/rest/v1/patient_visits?patient_id=eq.${row.id}`, { method: 'DELETE' });
    await sbFetch(`/rest/v1/patients?id=eq.${row.id}`, { method: 'DELETE' });
  }
  if (patients.length) ok(`Removed ${patients.length} prior demo patient(s)`);
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

async function createVisit(clinicId, patient, row, doctorProfileId) {
  const visitDate = todayISO();
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
    checked_in_at: new Date().toISOString(),
  };
  if (row.visit_status === 'in_consultation') {
    body.consultation_started_at = new Date().toISOString();
  }
  if (row.visit_status === 'completed') {
    body.consultation_started_at = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    body.completed_at = new Date().toISOString();
  }

  const ins = await sbFetch('/rest/v1/patient_visits', {
    method: 'POST',
    prefer: 'return=representation',
    body,
  });
  if (!ins.ok) fail(`visit insert failed for ${row.name}: ${JSON.stringify(ins.json)}`);
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

function saveManifest({ clinicId, profiles, visitCount }) {
  const buildDir = path.join(repoRoot, 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  const manifest = {
    hospital_name: HOSPITAL_NAME,
    clinic_id: clinicId,
    visit_date: todayISO(),
    visits_seeded: visitCount,
    doctors: DOCTORS.map(d => ({
      name: d.doctor_name,
      username: d.login_username,
      password: d.password,
    })),
    dashboard_url: process.env.DOCTOR_DASHBOARD_URL || 'https://vaitalcare-doctor.vercel.app',
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

  console.log(`\n── Swastik Hospital dummy data seed ──\n`);

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
  }

  await cleanupPriorSeed(clinicId);
  const visitCount = await seedDummyQueue(clinicId, profiles);
  ok(`Seeded ${visitCount} dummy queue visits for ${todayISO()}`);

  const waiting = DUMMY_QUEUE.filter(r => r.visit_status === 'waiting').length;
  const consult = DUMMY_QUEUE.filter(r => r.visit_status === 'in_consultation').length;
  const done = DUMMY_QUEUE.filter(r => r.visit_status === 'completed').length;
  console.log(`   Queue mix: ${waiting} waiting · ${consult} in consultation · ${done} completed`);

  const manifestPath = saveManifest({ clinicId, profiles, visitCount });
  ok(`Manifest saved to ${manifestPath}`);

  console.log('\n── Doctor dashboard logins ──');
  console.log(`   URL: ${process.env.DOCTOR_DASHBOARD_URL || 'https://vaitalcare-doctor.vercel.app'}`);
  for (const d of DOCTORS) {
    console.log(`   ${d.doctor_name}`);
    console.log(`     username: ${d.login_username}`);
    console.log(`     password: ${d.password}`);
  }

  console.log('\n[seed-swastik-hospital] Done. Sign in and pick today\'s date in the queue.\n');
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
