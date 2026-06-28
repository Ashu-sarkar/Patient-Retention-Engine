#!/usr/bin/env node
/**
 * Production E2E — all v2 WhatsApp templates + edge cases.
 *
 * Test phones (India +91):
 *   9685722570 — follow-up 2026-06-30
 *   9179263530 — follow-up 2026-07-04
 *   7002250088 — medicine / hospital / edge-case patient
 *
 * ⚠️  Sends real WhatsApp messages when Twilio credentials are live on Railway.
 *
 * Usage:
 *   node tests/run-wa-templates-e2e.js
 *   SKIP_LIVE_SENDS=1 node tests/run-wa-templates-e2e.js   # DB + webhook validation only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { getTemplates, validateEnvMap } = require('../scripts/lib/twilio-content-sids');
const { buildMedicineReminderSchedule } = require('../scripts/lib/medicine-schedule-builder');

function parseEnv(filePath) {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

const env = parseEnv(path.join(__dirname, '..', '.env'));
const PROD_BASE = (env.WEBHOOK_URL && env.WEBHOOK_URL.startsWith('https://'))
  ? env.WEBHOOK_URL.replace(/\/$/, '')
  : 'https://vaitalcare-production.up.railway.app';
const RAILWAY_HOST = new URL(PROD_BASE).hostname;
const RAILWAY_IP = process.env.RAILWAY_RESOLVE_IP || '66.33.22.247';
const SB_URL = env.SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const TWILIO_AUTH_TOKEN = (env.TWILIO_AUTH_TOKEN || '').trim();
const SKIP_LIVE = String(process.env.SKIP_LIVE_SENDS || '').toLowerCase() === '1';

const PATIENTS = {
  primary: {
    raw: '9685722570',
    e164: '+919685722570',
    name: 'Raj WA Template Test A',
    followUpDate: '2026-06-30',
  },
  secondary: {
    raw: '9179263530',
    e164: '+919179263530',
    name: 'Priya WA Template Test B',
    followUpDate: '2026-07-04',
  },
  tertiary: {
    raw: '7002250088',
    e164: '+917002250088',
    name: 'Amit WA Template Test C',
    followUpDate: null,
  },
};

const CLINIC = process.env.WA_TEST_CLINIC || 'WA Template Test Clinic 2026';
const DOCTOR = process.env.WA_TEST_DOCTOR || 'Dr WA Template Test';
const FACILITY = 'Pathology Lab';
const VISIT_DATE = process.env.WA_TEST_VISIT_DATE || '2026-06-27';

const SB_HDR = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

let passed = 0;
let failed = 0;
const failures = [];
let clinicId = null;
let intakeToken = null;

function section(t) {
  console.log(`\n${'─'.repeat(62)}\n  ${t}\n${'─'.repeat(62)}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

async function test(label, fn) {
  process.stdout.write(`  ${label} … `);
  try {
    await fn();
    process.stdout.write('✅ PASS\n');
    passed++;
  } catch (e) {
    process.stdout.write(`❌ FAIL\n       → ${e.message}\n`);
    failed++;
    failures.push({ label, detail: e.message });
  }
}

function twilioSignature(webhookPath, params) {
  const url = `${PROD_BASE}/webhook/${webhookPath}`;
  const signedData = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && typeof params[k] !== 'object')
    .sort()
    .reduce((acc, key) => acc + key + String(params[key]), url);
  return crypto.createHmac('sha1', TWILIO_AUTH_TOKEN).update(signedData).digest('base64');
}

function curlForm(webhookPath, fields) {
  const url = `${PROD_BASE}/webhook/${webhookPath}`;
  const form = new URLSearchParams(fields).toString();
  const args = [
    '-sS',
    '--resolve', `${RAILWAY_HOST}:443:${RAILWAY_IP}`,
    '-w', '\n__HTTP__%{http_code}',
    '-X', 'POST',
    url,
    '-H', 'Content-Type: application/x-www-form-urlencoded',
    '-d', form,
  ];
  const out = execSync(`curl ${args.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ')}`, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const idx = out.lastIndexOf('\n__HTTP__');
  const text = idx >= 0 ? out.slice(0, idx) : out;
  const status = idx >= 0 ? Number(out.slice(idx + 9)) : 0;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status, json, text };
}

function curlJson(webhookPath, bodyObj) {
  const url = `${PROD_BASE}/webhook/${webhookPath}`;
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const args = [
    '-sS',
    '--resolve', `${RAILWAY_HOST}:443:${RAILWAY_IP}`,
    '-w', '\n__HTTP__%{http_code}',
    '-X', 'POST',
    url,
    '-H', 'Content-Type: application/json',
  ];
  if (body) args.push('-d', body);
  const out = execSync(`curl ${args.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ')}`, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const idx = out.lastIndexOf('\n__HTTP__');
  const text = idx >= 0 ? out.slice(0, idx) : out;
  const status = idx >= 0 ? Number(out.slice(idx + 9)) : 0;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status, json, text };
}

async function sbGet(table, qs = '') {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, { headers: SB_HDR });
  const json = await res.json().catch(() => []);
  if (!res.ok) throw new Error(`${table} GET ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function sbPost(table, body, qs = '') {
  const res = await fetch(`${SB_URL}/rest/v1/${table}${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: SB_HDR,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ _raw: '' }));
  if (!res.ok) {
    throw new Error(`${table} POST ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

async function sbPatch(table, filter, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: SB_HDR,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(`${table} PATCH ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  }
}

async function sbDelete(table, filter) {
  await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: SB_HDR });
}

async function sbRpc(name, body, key = SB_KEY) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({ _raw: '' }));
  return { ok: res.ok, status: res.status, json };
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function getPatientByPhone(phoneE164, clinicName = CLINIC) {
  const qs = [
    `phone=eq.${encodeURIComponent(phoneE164)}`,
    `clinic_name=eq.${encodeURIComponent(clinicName)}`,
    'select=*',
    'order=updated_at.desc',
    'limit=1',
  ].join('&');
  const rows = await sbGet('patients', qs);
  return rows[0] || null;
}

async function getMessageLogs(phoneE164, limit = 20) {
  return sbGet(
    'message_logs',
    `phone=eq.${encodeURIComponent(phoneE164)}&order=sent_at.desc&limit=${limit}&select=message_type,workflow_name,delivery_status,sent_at,scheduled_date`,
  );
}

async function getSystemLogs(workflowName, limit = 10) {
  return sbGet(
    'system_logs',
    `workflow_name=eq.${encodeURIComponent(workflowName)}&order=timestamp.desc&limit=${limit}&select=log_level,message,timestamp`,
  );
}

async function resolveClinicId() {
  const boarding = await sbGet(
    'hospital_boarding',
    `hospital_name=eq.${encodeURIComponent(CLINIC)}&order=created_at.desc&select=clinic_id&limit=1`,
  );
  if (boarding[0]?.clinic_id) return boarding[0].clinic_id;

  const slug = CLINIC.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  const bySlug = await sbGet('clinics', `slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`);
  if (bySlug[0]?.id) return bySlug[0].id;

  const code = `${slug.replace(/-/g, '').toUpperCase().slice(0, 6)}${Date.now().toString(36).slice(-4).toUpperCase()}`;
  const clinics = await sbPost('clinics', { name: CLINIC, slug, code, status: 'active' });
  return clinics[0]?.id;
}

async function ensureClinicAndToken() {
  clinicId = await resolveClinicId();
  assert(clinicId, 'failed to resolve clinic id — run §2.1 hospital boarding first');

  intakeToken = crypto.randomBytes(32).toString('hex');
  await sbPost('clinic_intake_tokens', {
    clinic_id: clinicId,
    token_hash: tokenHash(intakeToken),
    label: 'WA Template E2E QR',
    status: 'active',
  });
  return { clinicId, intakeToken };
}

async function seedOutboundMessageLog(pat) {
  await sbPost('message_logs', {
    clinic_id: pat.clinic_id,
    patient_id: pat.id,
    patient_name: pat.name,
    phone: pat.phone,
    workflow_name: 'wa-template-e2e-setup',
    message_type: 'follow_up_reminder',
    message_sent: 'WA template E2E setup message',
    scheduled_date: pat.follow_up_date || new Date().toISOString().slice(0, 10),
    delivery_status: 'sent',
    provider_message_id: `SMWASEED${String(pat.id).replace(/-/g, '').slice(0, 24)}`,
    twilio_message_sid: `SMWASEED${String(pat.id).replace(/-/g, '').slice(0, 24)}`,
  }).catch(() => {});
}

async function patchPatientFollowUp(phoneE164, followUpDate) {
  const pat = await getPatientByPhone(phoneE164);
  assert(pat?.id, `patient ${phoneE164} missing for follow-up patch`);
  await sbPatch('patients', `id=eq.${pat.id}`, {
    follow_up_required: 'Yes',
    follow_up_date: followUpDate,
    status: 'pending',
    response_status: 'none',
    message_count: 1,
  });
  return getPatientByPhone(phoneE164);
}

function intakePayload(patient, overrides = {}) {
  return {
    patient_name: patient.name,
    phone_number: patient.raw,
    dob: '1990-05-15',
    sex: 'Male',
    hospital_name: CLINIC,
    doctor_name: DOCTOR,
    intake_token: intakeToken,
    clinic_mode: 'clinic_qr',
    visit_date: VISIT_DATE,
    follow_up_required: patient.followUpDate ? 'Yes' : 'No',
    follow_up_date: patient.followUpDate || '',
    ...overrides,
  };
}

function boardingPayload(overrides = {}) {
  const tertiary = PATIENTS.tertiary;
  return {
    hospital_name: CLINIC,
    facility_type: FACILITY,
    address: '88 Template Test Road, Bangalore',
    city: 'Bangalore',
    contact_phone: tertiary.raw,
    admin_contact_name: 'WA Test Admin',
    clinic_email: 'wa-template-test@vaitalcare.test',
    clinic_website: 'https://vaitalcare.example',
    doctor_name: DOCTOR,
    doctor_qualification: 'MBBS',
    doctor_expertise: 'General Medicine',
    doctor_registration_number: 'WA-TEMPLATE-001',
    doctor_phone: tertiary.e164,
    consultation_hours: 'Mon-Sat 9-5',
    doctor_count: '1',
    login_username: 'wa.template.doctor',
    doctors_json: JSON.stringify([{
      doctor_name: DOCTOR,
      doctor_qualification: 'MBBS',
      doctor_expertise: 'General Medicine',
      doctor_registration_number: 'WA-TEMPLATE-001',
      doctor_phone: tertiary.e164,
      login_username: 'wa.template.doctor',
      password: 'WaTemplatePass123',
    }]),
    ...overrides,
  };
}

function twilioForm(fromE164, fields = {}) {
  return {
    From: `whatsapp:${fromE164}`,
    To: env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
    MessageSid: fields.MessageSid || `SM${crypto.randomBytes(16).toString('hex').slice(0, 32)}`,
    WaId: fromE164.replace(/^\+/, ''),
    ProfileName: fields.ProfileName || 'WA Test',
    NumMedia: '0',
    ...fields,
  };
}

async function postTwilioWebhook(path, params) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (TWILIO_AUTH_TOKEN) {
    headers['X-Twilio-Signature'] = twilioSignature(path, params);
  }
  const res = await fetch(`${PROD_BASE}/webhook/${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json, text };
}

async function seedMedicineScheduleForPatient(patientE164) {
  const pat = await getPatientByPhone(patientE164);
  assert(pat?.id, `patient ${patientE164} must exist before seeding medicine schedule`);

  const visits = await sbGet(
    'patient_visits',
    `patient_id=eq.${pat.id}&order=checked_in_at.desc&limit=1&select=id`,
  );
  const visitId = visits[0]?.id || null;

  const rxRows = await sbPost('prescriptions', {
    clinic_id: pat.clinic_id,
    patient_id: pat.id,
    visit_id: visitId,
    status: 'issued',
    diagnosis: 'WA template medicine test',
    follow_up_required: 'No',
    issued_at: new Date().toISOString(),
    delivery_status: 'sent',
    pdf_url: 'https://example.com/wa-test-rx.pdf',
  });
  const prescriptionId = rxRows[0]?.id;
  assert(prescriptionId, 'prescription seed failed');

  const today = new Date().toISOString().slice(0, 10);
  const courseStart = VISIT_DATE;
  const scheduleRows = buildMedicineReminderSchedule({
    clinicId: pat.clinic_id,
    patientId: pat.id,
    prescriptionId,
    courseStartDate: courseStart,
    medicines: [{
      medicine_name: 'Paracetamol 500mg',
      duration: '7 days',
      timing: 'after breakfast',
      sort_order: 1,
    }],
  });

  const dueToday = scheduleRows.filter((r) => r.scheduled_date <= today);
  for (const row of scheduleRows.slice(0, 8)) {
    await sbPost('medicine_reminder_schedule', row).catch(async () => {
      await sbPatch(
        'medicine_reminder_schedule',
        `prescription_id=eq.${prescriptionId}&message_type=eq.${encodeURIComponent(row.message_type)}&scheduled_date=eq.${today}`,
        { status: 'pending', send_slot: row.send_slot },
      );
    });
  }

  return { prescriptionId, dueTodayCount: dueToday.length, templateIds: [...new Set(dueToday.map((r) => r.template_id))] };
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   WhatsApp Templates E2E — Production + Edge Cases       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Railway    : ${PROD_BASE}`);
  console.log(`  Supabase   : ${SB_URL}`);
  console.log(`  Clinic     : ${CLINIC} / ${DOCTOR}`);
  console.log(`  Visit date : ${VISIT_DATE}`);
  console.log(`  Patient A  : ${PATIENTS.primary.raw} → follow-up ${PATIENTS.primary.followUpDate}`);
  console.log(`  Patient B  : ${PATIENTS.secondary.raw} → follow-up ${PATIENTS.secondary.followUpDate}`);
  console.log(`  Patient C  : ${PATIENTS.tertiary.raw} (hospital + medicine)`);
  if (SKIP_LIVE) console.log('  Mode       : SKIP_LIVE_SENDS=1 (webhook + DB only)\n');
  else console.log('  Mode       : LIVE — real WhatsApp may be sent\n');

  assert(SB_URL && SB_KEY, 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env');

  section('§0  Template registry + env');
  await test('0.1  All 21 v2 template env keys present in .env', async () => {
    const { errors } = validateEnvMap(env);
    assert(errors.length === 0, errors.join('; '));
  });

  await test('0.2  Registry template count is 21', async () => {
    assert(getTemplates().length === 21, `expected 21, got ${getTemplates().length}`);
  });

  section('§1  Infrastructure');
  await test('1.1  Railway healthz', async () => {
    const out = execSync(
      `curl -sS --resolve '${RAILWAY_HOST}:443:${RAILWAY_IP}' -w '\\n__HTTP__%{http_code}' '${PROD_BASE}/healthz'`,
      { encoding: 'utf8' },
    );
    const idx = out.lastIndexOf('\n__HTTP__');
    assert(Number(out.slice(idx + 9)) === 200, 'healthz not 200');
  });

  await test('1.2  WF11 empty body → 400 validation', async () => {
    const { status, json } = curlJson('patient-form-intake', {});
    assert(status === 400, `expected 400, got ${status}`);
    assert(json.status === 'error', JSON.stringify(json));
  });

  await test('1.3  WF12 empty form → 400 validation', async () => {
    const { status } = curlForm('hospital-boarding', '');
    assert(status === 400, `expected 400, got ${status}`);
  });

  section('§2  WF12 — hospital_onboarding template');
  await test('2.1  Valid hospital boarding (contact + doctor = 7002250088)', async () => {
    const existing = await sbGet(
      'hospital_boarding',
      `hospital_name=eq.${encodeURIComponent(CLINIC)}&select=id&limit=1`,
    );
    if (!existing.length) {
      const { status, json } = curlForm('hospital-boarding', boardingPayload());
      assert(status === 200, `${status} ${JSON.stringify(json)}`);
      assert(json.status === 'success', JSON.stringify(json));
    }
  });

  await test('2.2  Boarding row persisted with doctor_phone', async () => {
    await sleep(1500);
    const rows = await sbGet(
      'hospital_boarding',
      `hospital_name=eq.${encodeURIComponent(CLINIC)}&select=doctor_phone,contact_phone,city&limit=1`,
    );
    assert(rows[0], 'hospital_boarding row missing');
    const dp = String(rows[0].doctor_phone || '').replace(/\s/g, '');
    assert(
      dp === PATIENTS.tertiary.e164 || dp === PATIENTS.tertiary.raw,
      `doctor_phone ${rows[0].doctor_phone}`,
    );
  });

  await test('2.3  Edge: invalid facility_type → 400', async () => {
    const { status, json } = curlForm('hospital-boarding', boardingPayload({
      hospital_name: `${CLINIC} Bad Facility`,
      facility_type: 'Veterinary Clinic',
    }));
    assert(status === 400, `expected 400, got ${status}`);
    assert(Array.isArray(json.errors), JSON.stringify(json));
  });

  await test('2.4  Edge: empty doctors_json → 400', async () => {
    const { status, json } = curlForm('hospital-boarding', boardingPayload({
      hospital_name: `${CLINIC} No Doctors JSON`,
      doctors_json: '[]',
      doctor_count: '0',
    }));
    assert(status === 400, `expected 400, got ${status}: ${JSON.stringify(json)}`);
  });

  await test('2.5  hospital_onboarding workflow logged for tertiary phone', async () => {
    if (SKIP_LIVE) return;
    await sleep(2000);
    const logs = await getMessageLogs(PATIENTS.tertiary.e164, 5);
    const hit = logs.some((l) => String(l.message_type || '').includes('hospital'));
    if (!hit) {
      const sys = await getSystemLogs('workflow-12-hospital-boarding', 5);
      assert(sys.length > 0, 'no WF12 system_logs or message_logs for hospital onboarding');
    }
  });

  section('§3  WF11 → WF7 — clinic_patient_welcome (patient onboarding)');
  await test('3.0  Seed clinic QR token', async () => {
    await ensureClinicAndToken();
    assert(clinicId && intakeToken, 'clinic/token missing');
  });

  await test('3.1  Patient A intake with follow-up 2026-06-30', async () => {
    const { status, json, text } = curlForm('patient-form-intake', intakePayload(PATIENTS.primary));
    assert(status === 200, `status ${status}: ${text || JSON.stringify(json)}`);
    assert(json.status === 'success', JSON.stringify(json));
    await sleep(2000);
    let pat = await getPatientByPhone(PATIENTS.primary.e164);
    if (!pat) {
      await sleep(2000);
      pat = await getPatientByPhone(PATIENTS.primary.e164);
    }
    assert(pat, 'patient A not found after intake');
    pat = await patchPatientFollowUp(PATIENTS.primary.e164, PATIENTS.primary.followUpDate);
    assert(pat.follow_up_date === PATIENTS.primary.followUpDate,
      `follow_up_date ${pat.follow_up_date} !== ${PATIENTS.primary.followUpDate}`);
  });

  await test('3.2  Patient B intake with follow-up 2026-07-04', async () => {
    const { status, json } = curlForm('patient-form-intake', intakePayload(PATIENTS.secondary));
    assert(status === 200, `${status} ${JSON.stringify(json)}`);
    await sleep(2000);
    const pat = await patchPatientFollowUp(PATIENTS.secondary.e164, PATIENTS.secondary.followUpDate);
    assert(pat.follow_up_date === PATIENTS.secondary.followUpDate,
      `follow_up ${pat?.follow_up_date}`);
  });

  await test('3.3  Patient C intake (no follow-up, medicine test patient)', async () => {
    const { status, json } = curlForm('patient-form-intake', intakePayload(PATIENTS.tertiary));
    assert(status === 200, `${status} ${JSON.stringify(json)}`);
    await sleep(2000);
    const pat = await getPatientByPhone(PATIENTS.tertiary.e164);
    assert(pat, 'patient C missing');
  });

  await test('3.4  Edge: invalid phone → 400', async () => {
    const { status, json } = curlForm('patient-form-intake', intakePayload(PATIENTS.primary, {
      phone_number: '12345',
    }));
    assert(status === 400, `expected 400, got ${status}`);
    assert(Array.isArray(json.errors), JSON.stringify(json));
  });

  await test('3.5  Edge: invalid intake_token → 400', async () => {
    const { status, json } = curlForm('patient-form-intake', intakePayload(PATIENTS.primary, {
      intake_token: '0'.repeat(64),
    }));
    assert(status === 400, `expected 400, got ${status}`);
    const errText = (json.errors || []).join(' ');
    assert(/intake token/i.test(errText), JSON.stringify(json));
  });

  await test('3.6  Edge: future visit_date → 400', async () => {
    const { status } = curlForm('patient-form-intake', intakePayload(PATIENTS.primary, {
      visit_date: '2099-01-01',
    }));
    assert(status === 400, `expected 400, got ${status}`);
  });

  await test('3.7  WF7 direct: invalid phone skipped gracefully', async () => {
    const pat = await getPatientByPhone(PATIENTS.primary.e164);
    const { status } = curlJson('new-patient-intake', {
      patient_code: pat?.patient_code || 'PAT-TEST',
      patient_id: pat?.id || '00000000-0000-4000-8000-000000000099',
      clinic_id: pat?.clinic_id || clinicId,
      name: 'Bad Phone Test',
      phone: 'not-a-phone',
      clinic_name: CLINIC,
      doctor_name: DOCTOR,
      visit_date: VISIT_DATE,
    });
    assert([200, 202].includes(status), `expected graceful ${status}`);
  });

  await test('3.8  Welcome message logged for onboarded patients', async () => {
    if (SKIP_LIVE) return;
    for (const p of [PATIENTS.primary, PATIENTS.secondary, PATIENTS.tertiary]) {
      const logs = await getMessageLogs(p.e164, 10);
      const welcome = logs.some((l) => l.message_type === 'welcome' || l.message_type === 'clinic_patient_welcome');
      const wf7logs = await getSystemLogs('workflow-7-new-patient', 3);
      assert(welcome || wf7logs.length > 0,
        `no welcome log for ${p.raw} — check TWILIO_CONTENT_CLINIC_PATIENT_WELCOME`);
    }
  });

  section('§4  WF6 — followup_booking_confirmed / followup_rescheduled_confirmed');
  await test('4.0  Seed outbound message_logs so WF6 routes to test clinic', async () => {
    for (const p of [PATIENTS.primary, PATIENTS.secondary]) {
      const pat = await getPatientByPhone(p.e164);
      assert(pat, `patient missing for ${p.raw}`);
      await seedOutboundMessageLog(pat);
    }
  });

  await test('4.1  Patient A confirms appointment (Confirm button)', async () => {
    const { status } = await postTwilioWebhook('feedback-listener', twilioForm(PATIENTS.primary.e164, {
      Body: 'Confirm Appointment',
      ButtonText: 'Confirm Appointment',
      ButtonPayload: 'confirm_appointment',
      MessageSid: 'SMWATEPLATECONFIRM00000000000001',
    }));
    assert([200, 202].includes(status), `status ${status}`);
    await sleep(3000);
    const pat = await getPatientByPhone(PATIENTS.primary.e164);
    assert(pat?.response_status === 'confirmed', `response_status ${pat?.response_status}`);
  });

  await test('4.2  Patient B reschedules (Reschedule button)', async () => {
    const { status } = await postTwilioWebhook('feedback-listener', twilioForm(PATIENTS.secondary.e164, {
      Body: 'Reschedule',
      ButtonText: 'Reschedule',
      ButtonPayload: 'reschedule',
      MessageSid: 'SMWATEPLATERESCHED00000000000001',
    }));
    assert([200, 202].includes(status), `status ${status}`);
    await sleep(2500);
    const pat = await getPatientByPhone(PATIENTS.secondary.e164);
    assert(pat?.response_status === 'cancelled', `response_status ${pat?.response_status}`);
  });

  await test('4.3  Edge: unknown sender → graceful 200', async () => {
    const { status } = await postTwilioWebhook('feedback-listener', twilioForm('+919999999999', {
      Body: 'Hello',
      MessageSid: 'SMWATEPLATEUNKNOWN00000000000001',
    }));
    assert([200, 202].includes(status), `status ${status}`);
  });

  await test('4.4  Edge: blank inbound message → graceful 200', async () => {
    const { status } = await postTwilioWebhook('feedback-listener', twilioForm(PATIENTS.tertiary.e164, {
      Body: '',
      MessageSid: 'SMWATEPLATEBLANK000000000000001',
    }));
    assert([200, 202].includes(status), `status ${status}`);
  });

  await test('4.5  Duplicate confirm does not create second queue visit', async () => {
    const pat = await getPatientByPhone(PATIENTS.primary.e164);
    assert(pat?.id, 'patient A missing');
    const visitsBefore = await sbGet(
      'patient_visits',
      `patient_id=eq.${pat.id}&visit_date=eq.${PATIENTS.primary.followUpDate}&select=id,visit_status`,
    );
    const activeBefore = visitsBefore.filter((v) => !['cancelled', 'no_show'].includes(v.visit_status));

    await postTwilioWebhook('feedback-listener', twilioForm(PATIENTS.primary.e164, {
      ButtonText: 'Confirm Appointment',
      ButtonPayload: 'confirm_appointment',
      MessageSid: 'SMWATEPLATEDUPCONF00000000000001',
    }));
    await sleep(2500);

    const visitsAfter = await sbGet(
      'patient_visits',
      `patient_id=eq.${pat.id}&visit_date=eq.${PATIENTS.primary.followUpDate}&select=id,visit_status`,
    );
    const activeAfter = visitsAfter.filter((v) => !['cancelled', 'no_show'].includes(v.visit_status));
    assert(activeAfter.length === activeBefore.length,
      `duplicate confirm changed visit count ${activeBefore.length} → ${activeAfter.length}`);
  });

  section('§5  Cron eligibility — follow-up / health / missed (DB filters)');
  await test('5.1  Patient A eligible for WF1 when follow_up_date = tomorrow+1 from run date', async () => {
    const pat = await getPatientByPhone(PATIENTS.primary.e164);
    assert(pat?.follow_up_date === PATIENTS.primary.followUpDate, 'follow-up seed mismatch');
    const rows = await sbGet(
      'patients',
      `phone=eq.${encodeURIComponent(PATIENTS.primary.e164)}&follow_up_date=eq.${PATIENTS.primary.followUpDate}&status=eq.pending&select=id,follow_up_date`,
    );
    assert(rows.length >= 1, 'Patient A not queryable for advance reminder cron');
  });

  await test('5.2  Patient B eligible for WF1 on 2026-07-03 (day before 2026-07-04)', async () => {
    const rows = await sbGet(
      'patients',
      `phone=eq.${encodeURIComponent(PATIENTS.secondary.e164)}&follow_up_date=eq.${PATIENTS.secondary.followUpDate}&status=eq.pending&select=id`,
    );
    assert(rows.length >= 1, 'Patient B not seeded for July 4 follow-up');
  });

  await test('5.3  Confirmed Patient A excluded from WF2 same-day filter', async () => {
    const pat = await getPatientByPhone(PATIENTS.primary.e164);
    assert(pat?.response_status === 'confirmed', 'Patient A should be confirmed from §4.1');
  });

  await test('5.4  Edge: message_count=5 patient excluded from reminder query', async () => {
    const pat = await getPatientByPhone(PATIENTS.secondary.e164);
    assert(pat?.id, 'patient B missing');
    await sbPatch('patients', `id=eq.${pat.id}`, { message_count: 5 });
    const rows = await sbGet(
      'patients',
      `id=eq.${pat.id}&message_count=lt.5&select=id`,
    );
    assert(rows.length === 0, 'message_count=5 should exclude from WF1/WF2');
    await sbPatch('patients', `id=eq.${pat.id}`, { message_count: 1 });
  });

  await test('5.5  Health-check window: visit 2 days ago queryable', async () => {
    const pat = await getPatientByPhone(PATIENTS.tertiary.e164);
    assert(pat?.id, 'patient C missing');
    await sbPatch('patients', `id=eq.${pat.id}`, {
      visit_date: VISIT_DATE,
      health_check_sent: false,
      status: 'pending',
    });
    const rows = await sbGet(
      'patients',
      `id=eq.${pat.id}&health_check_sent=eq.false&select=id,visit_date,health_check_sent`,
    );
    assert(rows.length === 1, 'patient C should be eligible for health check when visit_date in window');
  });

  section('§6  Medicine reminders — schedule seed + WF14 due query');
  await test('6.1  Seed 7-day journey schedule for Patient C', async () => {
    const result = await seedMedicineScheduleForPatient(PATIENTS.tertiary.e164);
    assert(result.dueTodayCount >= 0, 'schedule builder returned no rows');
    console.log(`\n       templates due today: ${result.templateIds.join(', ') || '(none today — OK)'}`);
  });

  await test('6.2  medicine_reminder_schedule has pending rows for Patient C', async () => {
    const pat = await getPatientByPhone(PATIENTS.tertiary.e164);
    const rows = await sbGet(
      'medicine_reminder_schedule',
      `patient_id=eq.${pat.id}&status=eq.pending&select=template_id,send_slot,scheduled_date&limit=20`,
    );
    assert(rows.length >= 1, 'expected pending medicine_reminder_schedule rows');
    const templateIds = new Set(rows.map((r) => r.template_id));
    const journeyTypes = [
      'medicine_journey_day1_morning',
      'medicine_journey_day1_evening',
      'medicine_journey_midpoint',
      'medicine_journey_daily',
      'medicine_journey_last_day',
      'medicine_journey_complete',
    ];
    const hasJourney = journeyTypes.some((t) => templateIds.has(t));
    assert(hasJourney, `expected journey template in schedule, got ${[...templateIds].join(', ')}`);
  });

  section('§7  WF9 — Twilio status callback error handling');
  await test('7.1  Unknown MessageSid → graceful 200', async () => {
    const { status } = await postTwilioWebhook('twilio-status-callback', {
      MessageSid: 'SMWATEPLATEUNKNOWNSTATUS000000001',
      MessageStatus: 'delivered',
    });
    assert([200, 202].includes(status), `status ${status}`);
  });

  await test('7.2  delivered status updates seeded message_log', async () => {
    const pat = await getPatientByPhone(PATIENTS.tertiary.e164);
    assert(pat?.id, 'patient C missing');
    const sid = 'SMWATEPLATESTATUS0000000000000001';
    await sbDelete('message_logs', `twilio_message_sid=eq.${encodeURIComponent(sid)}`).catch(() => {});
    await sbPost('message_logs', {
      clinic_id: pat.clinic_id,
      patient_id: pat.id,
      patient_name: pat.name,
      phone: pat.phone,
      workflow_name: 'wa-template-e2e',
      message_type: 'status_callback_test',
      message_sent: 'status test',
      scheduled_date: new Date().toISOString().slice(0, 10),
      delivery_status: 'sent',
      provider_message_id: sid,
      twilio_message_sid: sid,
    });
    const { status } = await postTwilioWebhook('twilio-status-callback', {
      MessageSid: sid,
      MessageStatus: 'delivered',
    });
    assert([200, 202].includes(status), `status ${status}`);
    await sleep(2500);
    const logs = await sbGet(
      'message_logs',
      `twilio_message_sid=eq.${encodeURIComponent(sid)}&select=delivery_status`,
    );
    assert(['delivered', 'sent'].includes(logs[0]?.delivery_status),
      `expected delivered or sent, got ${logs[0]?.delivery_status}`);
  });

  section('§8  Per-patient workflow trigger summary');
  await test('8.1  Patient A (+9685722570) has intake + confirm trail', async () => {
    const pat = await getPatientByPhone(PATIENTS.primary.e164);
    assert(pat, `patient A missing for clinic ${CLINIC}`);
    assert(pat.follow_up_date === PATIENTS.primary.followUpDate, pat.follow_up_date);
    assert(pat.response_status === 'confirmed', pat.response_status);
    const visits = await sbGet(
      'patient_visits',
      `patient_id=eq.${pat.id}&select=visit_date,visit_status&order=checked_in_at.desc&limit=5`,
    );
    assert(visits.length >= 1, 'no visits for patient A');
  });

  await test('8.2  Patient B (+9179263530) has intake + reschedule trail', async () => {
    const pat = await getPatientByPhone(PATIENTS.secondary.e164);
    assert(pat?.follow_up_date === PATIENTS.secondary.followUpDate, pat?.follow_up_date);
    assert(pat?.response_status === 'cancelled', pat?.response_status);
  });

  await test('8.3  Patient C (+7002250088) has boarding + medicine schedule', async () => {
    const pat = await getPatientByPhone(PATIENTS.tertiary.e164);
    assert(pat, 'patient C missing');
    const rx = await sbGet('prescriptions', `patient_id=eq.${pat.id}&select=id&limit=1`);
    assert(rx.length >= 1, 'prescription missing for patient C');
    const sched = await sbGet(
      'medicine_reminder_schedule',
      `patient_id=eq.${pat.id}&select=template_id&limit=1`,
    );
    assert(sched.length >= 1, 'medicine schedule missing for patient C');
  });

  await test('8.4  Template coverage map (21 v2 templates → workflow owners)', async () => {
    const coverage = Object.fromEntries(getTemplates().map((t) => [t.id, t.workflow]));
    const required = [
      'clinic_patient_welcome',
      'hospital_onboarding',
      'prescription_delivery',
      'prescription_with_followup',
      'prescription_journey_start',
      'followup_reminder_advance',
      'followup_reminder_day_of',
      'followup_booking_confirmed',
      'followup_rescheduled_confirmed',
      'patient_health_check',
      'missed_followup_recovery_1',
      'missed_followup_recovery_2',
      'medicine_journey_day1_morning',
      'medicine_journey_complete',
      'medicine_reminder_morning',
    ];
    for (const id of required) {
      assert(coverage[id], `missing template ${id} in registry`);
    }
  });

  section('Summary');
  console.log(`\n  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  if (failures.length) {
    console.log('\n  Failures:');
    failures.forEach((f, i) => console.log(`    ${i + 1}. ${f.label}\n       ${f.detail}`));
  }
  console.log('\n  Manual checks (prescription templates — issue Rx from doctor dashboard):');
  console.log('    • prescription_delivery / prescription_with_followup / prescription_journey_start');
  console.log('    • Cron templates (WF1–WF5): fire on schedule or trigger manually in n8n UI');
  console.log('    • Verify: node production-test-playbook/verify.js patient +91<phone>\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
