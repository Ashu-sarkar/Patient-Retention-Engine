#!/usr/bin/env node
/**
 * End-to-end prescription delivery test for Swastik Hospital.
 *
 * Seeds (or reuses) a patient, issues a PDF prescription, and invokes the
 * prescription-delivery edge function to send WhatsApp to the target phone.
 *
 * Usage:
 *   node scripts/test-swastik-prescription-delivery.mjs
 *   TEST_PHONE_RAW=9685722570 node scripts/test-swastik-prescription-delivery.mjs
 *
 * Requires .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
 */

import crypto from 'crypto';
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
const SB_URL = (env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON_KEY = env.SUPABASE_ANON_KEY || '';
const INTERNAL_SECRET = env.INTERNAL_WEBHOOK_SECRET || '';

const PHONE_RAW = env.TEST_PHONE_RAW || '9685722570';
const PHONE_E164 = PHONE_RAW.startsWith('+') ? PHONE_RAW : `+91${PHONE_RAW}`;
const HOSPITAL_NAME = env.SWASTIK_HOSPITAL || 'Swastik Hospital';
const DOCTOR_USERNAME = env.SWASTIK_DOCTOR_USERNAME || 'swastik.vikram';
const DOCTOR_PASSWORD = env.SWASTIK_DOCTOR_PASSWORD || 'Swastik123';
const DOCTOR_NAME = env.SWASTIK_DOCTOR_NAME || 'Dr. Vikram Swastik';
const PATIENT_NAME = env.TEST_PATIENT_NAME || 'Prescription Test Patient';
const SEED_TAG = 'Swastik prescription delivery test';

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

function usernameToEmail(username) {
  return `${String(username).trim().toLowerCase()}@auth.vaitalcare.local`;
}

function minimalPdfBytes(title) {
  const text = String(title || 'Swastik Hospital Prescription').slice(0, 120);
  const stream = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, ' ')}) Tj ET`;
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`,
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(body.length);
    body += `${obj}\n`;
  }
  const xrefPos = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(body, 'utf8');
}

async function hmacSha256Hex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

async function buildShortPdfLink(prescriptionId, clinicId) {
  const expiresAt = Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7);
  const token = (await hmacSha256Hex(INTERNAL_SECRET, `pdf:${prescriptionId}:${clinicId}:${expiresAt}`)).slice(0, 32);
  return `${SB_URL}/functions/v1/prescription-pdf?id=${prescriptionId}&c=${clinicId}&exp=${expiresAt}&t=${token}`;
}

async function sbFetch(endpoint, { method = 'GET', body, prefer, token = SERVICE_KEY } = {}) {
  const headers = {
    apikey: token === SERVICE_KEY ? SERVICE_KEY : ANON_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SB_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  return { ok: res.ok, status: res.status, json, text };
}

async function signInDoctor() {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: usernameToEmail(DOCTOR_USERNAME),
      password: DOCTOR_PASSWORD,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) fail(`Doctor login failed (${res.status}): ${JSON.stringify(json)}`);
  return json.access_token;
}

async function resolveClinicId() {
  const manifestPath = path.join(repoRoot, 'build', 'swastik-hospital-manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.clinic_id) return manifest.clinic_id;
  }
  const res = await sbFetch(
    `/rest/v1/hospital_boarding?hospital_name=eq.${encodeURIComponent(HOSPITAL_NAME)}&select=clinic_id&limit=1`,
  );
  const row = Array.isArray(res.json) ? res.json[0] : null;
  if (!row?.clinic_id) fail(`Could not resolve clinic_id for ${HOSPITAL_NAME}`);
  return row.clinic_id;
}

async function resolveDoctorProfile(clinicId) {
  const res = await sbFetch(
    `/rest/v1/doctor_profiles?clinic_id=eq.${clinicId}&login_username=eq.${encodeURIComponent(DOCTOR_USERNAME)}&select=id,user_id,doctor_name,clinic_name,registration_number,qualification,specialty&limit=1`,
  );
  const row = Array.isArray(res.json) ? res.json[0] : null;
  if (!row?.id) {
    const byName = await sbFetch(
      `/rest/v1/doctor_profiles?clinic_id=eq.${clinicId}&doctor_name=eq.${encodeURIComponent(DOCTOR_NAME)}&select=id,user_id,doctor_name,clinic_name,registration_number,qualification,specialty&limit=1`,
    );
    const named = Array.isArray(byName.json) ? byName.json[0] : null;
    if (!named?.id) fail(`Doctor profile not found for ${DOCTOR_USERNAME} at ${HOSPITAL_NAME}`);
    return named;
  }
  return row;
}

async function nextPatientCode(clinicId) {
  const res = await sbFetch('/rest/v1/rpc/next_patient_code', {
    method: 'POST',
    body: { p_clinic_id: clinicId },
  });
  if (!res.ok) fail(`next_patient_code failed: ${JSON.stringify(res.json)}`);
  return res.json;
}

async function ensurePatient(clinicId) {
  const existing = await sbFetch(
    `/rest/v1/patients?clinic_id=eq.${clinicId}&phone=eq.${encodeURIComponent(PHONE_E164)}&select=id,patient_code,name,clinic_id&limit=1`,
  );
  let patient = Array.isArray(existing.json) ? existing.json[0] : null;
  if (patient?.id) {
    await sbFetch(`/rest/v1/patients?id=eq.${patient.id}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: {
        name: PATIENT_NAME,
        clinic_name: HOSPITAL_NAME,
        doctor_name: DOCTOR_NAME,
        visit_date: todayISO(),
        notes: SEED_TAG,
        clinic_id: clinicId,
      },
    });
    ok(`Reusing patient ${patient.patient_code} (${patient.id})`);
  } else {
    const patientCode = await nextPatientCode(clinicId);
    const ins = await sbFetch('/rest/v1/patients', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        clinic_id: clinicId,
        patient_code: patientCode,
        name: PATIENT_NAME,
        phone: PHONE_E164,
        dob: '1990-05-15',
        sex: 'Male',
        clinic_name: HOSPITAL_NAME,
        doctor_name: DOCTOR_NAME,
        visit_date: todayISO(),
        follow_up_required: 'No',
        status: 'pending',
        message_count: 0,
        notes: SEED_TAG,
      },
    });
    if (!ins.ok) fail(`Patient insert failed: ${JSON.stringify(ins.json)}`);
    patient = Array.isArray(ins.json) ? ins.json[0] : ins.json;
    ok(`Created patient ${patient.patient_code} (${patient.id})`);
  }

  const fresh = await sbFetch(
    `/rest/v1/patients?id=eq.${patient.id}&select=id,patient_code,name,clinic_id&limit=1`,
  );
  patient = Array.isArray(fresh.json) ? fresh.json[0] : patient;
  if (!patient?.clinic_id || patient.clinic_id !== clinicId) {
    fail(`Patient clinic mismatch: expected ${clinicId}, got ${patient?.clinic_id || 'null'}`);
  }
  return patient;
}

async function ensureVisit(clinicId, patient, doctorProfile) {
  const visitDate = todayISO();
  const patientClinicId = patient.clinic_id || clinicId;
  const existing = await sbFetch(
    `/rest/v1/patient_visits?patient_id=eq.${patient.id}&visit_date=eq.${visitDate}&visit_status=not.in.(cancelled,no_show)&select=id,visit_status&limit=1`,
  );
  const found = Array.isArray(existing.json) ? existing.json[0] : null;
  if (found?.id) {
    await sbFetch(`/rest/v1/patient_visits?id=eq.${found.id}`, {
      method: 'PATCH',
      body: {
        visit_status: 'in_consultation',
        doctor_name: DOCTOR_NAME,
        clinic_name: HOSPITAL_NAME,
        doctor_profile_id: doctorProfile.id,
        chief_complaint: 'Prescription delivery test visit',
        staff_notes: SEED_TAG,
      },
    });
    ok(`Reusing visit ${found.id}`);
    return found.id;
  }

  const ins = await sbFetch('/rest/v1/patient_visits', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      clinic_id: patientClinicId,
      patient_id: patient.id,
      doctor_profile_id: doctorProfile.id,
      patient_code: patient.patient_code,
      clinic_name: HOSPITAL_NAME,
      doctor_name: DOCTOR_NAME,
      visit_date: visitDate,
      visit_status: 'in_consultation',
      chief_complaint: 'Prescription delivery test visit',
      staff_notes: SEED_TAG,
      checked_in_at: new Date().toISOString(),
      consultation_started_at: new Date().toISOString(),
    },
  });
  if (!ins.ok) fail(`Visit insert failed: ${JSON.stringify(ins.json)}`);
  const visit = Array.isArray(ins.json) ? ins.json[0] : ins.json;
  ok(`Created visit ${visit.id}`);
  return visit.id;
}

async function createIssuedPrescription({
  clinicId,
  patient,
  visitId,
  doctorProfile,
  doctorUserId,
  doctorToken,
}) {
  const doctorSnapshot = {
    name: doctorProfile.doctor_name || DOCTOR_NAME,
    registration_number: doctorProfile.registration_number || 'SWASTIK-REG-001',
    qualification: doctorProfile.qualification || 'MBBS, MD',
    specialty: doctorProfile.specialty || 'General Medicine',
  };
  const clinicSnapshot = {
    name: HOSPITAL_NAME,
    phone: PHONE_E164,
    address: '45 MG Road, Bengaluru',
    city: 'Bengaluru',
  };

  const draft = await sbFetch('/rest/v1/prescriptions', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      clinic_id: patient.clinic_id,
      patient_id: patient.id,
      visit_id: visitId,
      doctor_profile_id: doctorProfile.id,
      status: 'draft',
      diagnosis: 'Acute upper respiratory infection',
      clinical_remarks: 'Mild fever and cough for 2 days',
      advice: 'Rest, fluids, avoid cold foods. Return if fever persists beyond 3 days.',
      follow_up_required: 'No',
      follow_up_date: null,
      doctor_snapshot: doctorSnapshot,
      clinic_snapshot: clinicSnapshot,
      delivery_status: 'not_sent',
      created_by: doctorUserId,
    },
    token: doctorToken,
  });
  if (!draft.ok) fail(`Prescription draft failed: ${JSON.stringify(draft.json)}`);
  const prescription = Array.isArray(draft.json) ? draft.json[0] : draft.json;

  const meds = await sbFetch('/rest/v1/prescription_medicines', {
    method: 'POST',
    prefer: 'return=representation',
    body: [
      {
        prescription_id: prescription.id,
        clinic_id: patient.clinic_id,
        medicine_name: 'Paracetamol 500mg',
        generic_name: 'Paracetamol',
        dosage: '1 tablet',
        frequency: 'TDS',
        timing: 'After Breakfast',
        duration: '5 days',
        instructions: 'After meals with water',
        sort_order: 1,
      },
      {
        prescription_id: prescription.id,
        clinic_id: patient.clinic_id,
        medicine_name: 'Cetirizine 10mg',
        generic_name: 'Cetirizine',
        dosage: '1 tablet',
        frequency: 'OD',
        timing: 'After Dinner',
        duration: '5 days',
        instructions: 'At bedtime',
        sort_order: 2,
      },
    ],
    token: doctorToken,
  });
  if (!meds.ok) fail(`Medicines insert failed: ${JSON.stringify(meds.json)}`);

  const pdfBytes = minimalPdfBytes(`${HOSPITAL_NAME} — ${PATIENT_NAME}`);
  const storagePath = `${patient.clinic_id}/${doctorUserId}/${prescription.id}.pdf`;
  const uploadRes = await fetch(
    `${SB_URL}/storage/v1/object/prescriptions/${storagePath}`,
    {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/pdf',
        'x-upsert': 'true',
      },
      body: pdfBytes,
    },
  );
  if (!uploadRes.ok) {
    const uploadText = await uploadRes.text();
    fail(`PDF upload failed (${uploadRes.status}): ${uploadText.slice(0, 300)}`);
  }
  ok(`Uploaded PDF to prescriptions/${storagePath}`);

  const signRes = await sbFetch('/storage/v1/object/sign/prescriptions/' + encodeURIComponent(storagePath), {
    method: 'POST',
    body: { expiresIn: 60 * 60 * 24 * 7 },
  });
  const signedUrl = signRes.json?.signedURL
    ? `${SB_URL}/storage/v1${signRes.json.signedURL}`
    : signRes.json?.signedUrl;
  if (!signedUrl || !/^https:\/\//i.test(signedUrl)) {
    fail(`Signed URL failed: ${JSON.stringify(signRes.json)}`);
  }

  const issue = await sbFetch(`/rest/v1/prescriptions?id=eq.${prescription.id}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: {
      status: 'issued',
      issued_at: new Date().toISOString(),
      pdf_url: signedUrl,
      pdf_storage_path: storagePath,
      delivery_status: 'not_sent',
    },
    token: doctorToken,
  });
  if (!issue.ok) fail(`Issue prescription failed: ${JSON.stringify(issue.json)}`);
  const issued = Array.isArray(issue.json) ? issue.json[0] : issue.json;
  ok(`Issued prescription ${issued.id}`);
  return { prescription: issued, signedUrl, storagePath };
}

async function invokePrescriptionDelivery(prescriptionId, doctorToken) {
  const res = await fetch(`${SB_URL}/functions/v1/prescription-delivery`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${doctorToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prescription_id: prescriptionId }),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  return { ok: res.ok, status: res.status, json, text };
}

async function main() {
  if (!SB_URL || !SERVICE_KEY || !ANON_KEY) {
    fail('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ANON_KEY required in .env');
  }

  console.log(`\n── Swastik prescription delivery test ──`);
  console.log(`   Hospital : ${HOSPITAL_NAME}`);
  console.log(`   Doctor   : ${DOCTOR_USERNAME}`);
  console.log(`   Patient  : ${PATIENT_NAME} (${PHONE_E164})\n`);

  const clinicId = await resolveClinicId();
  ok(`Clinic ${clinicId}`);

  const doctorToken = await signInDoctor();
  ok(`Signed in as ${DOCTOR_USERNAME}`);

  const profileBootstrap = await sbFetch('/rest/v1/rpc/get_or_create_doctor_profile_for_current_user', {
    method: 'POST',
    body: {},
    token: doctorToken,
  });
  if (!profileBootstrap.ok) {
    console.warn(`⚠️  Doctor profile bootstrap: ${JSON.stringify(profileBootstrap.json).slice(0, 180)}`);
  }

  const doctorProfile = await resolveDoctorProfile(clinicId);
  const patient = await ensurePatient(clinicId);
  const visitId = await ensureVisit(clinicId, patient, doctorProfile);

  const { prescription, signedUrl, storagePath } = await createIssuedPrescription({
    clinicId,
    patient,
    visitId,
    doctorProfile,
    doctorUserId: doctorProfile.user_id,
    doctorToken,
  });

  const shortLink = INTERNAL_SECRET
    ? await buildShortPdfLink(prescription.id, patient.clinic_id)
    : '(set INTERNAL_WEBHOOK_SECRET in .env to build short link)';

  console.log('\n── Prescription assets ──');
  console.log(`   prescription_id : ${prescription.id}`);
  console.log(`   storage_path    : ${storagePath}`);
  console.log(`   signed_pdf_url  : ${signedUrl}`);
  console.log(`   short_pdf_link  : ${shortLink}`);

  console.log('\n── Sending WhatsApp via prescription-delivery edge function ──');
  const delivery = await invokePrescriptionDelivery(prescription.id, doctorToken);
  if (!delivery.ok || delivery.json?.error) {
    console.error(JSON.stringify(delivery.json, null, 2));
    fail(`Delivery failed (HTTP ${delivery.status})`);
  }

  ok(`WhatsApp sent — twilio sid: ${delivery.json?.twilio_message_sid || '(see response)'}`);
  if (delivery.json?.pdf_link) {
    console.log(`   WA short link   : ${delivery.json.pdf_link}`);
  }

  const logs = await sbFetch(
    `/rest/v1/message_logs?patient_id=eq.${patient.id}&message_type=like.prescription*&order=sent_at.desc&limit=3&select=message_type,delivery_status,sent_at,twilio_message_sid`,
  );
  console.log('\n── Recent prescription message logs ──');
  console.log(JSON.stringify(logs.json, null, 2));

  const manifestPath = path.join(repoRoot, 'build', 'swastik-prescription-test.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    hospital_name: HOSPITAL_NAME,
    clinic_id: clinicId,
    patient_id: patient.id,
    patient_code: patient.patient_code,
    phone: PHONE_E164,
    prescription_id: prescription.id,
    pdf_signed_url: signedUrl,
    pdf_short_link: delivery.json?.pdf_link || shortLink,
    twilio_message_sid: delivery.json?.twilio_message_sid || null,
    created_at: new Date().toISOString(),
  }, null, 2)}\n`);
  ok(`Manifest saved to ${manifestPath}`);

  console.log('\n[test-swastik-prescription-delivery] Done. Check WhatsApp on ' + PHONE_E164 + '.\n');
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
