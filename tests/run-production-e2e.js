#!/usr/bin/env node
/**
 * Production E2E — live Railway webhooks + Supabase verification.
 * Uses test phone 9685722570 (+919685722570) unless overridden via E2E_PHONE_RAW.
 *
 * Usage: node tests/run-production-e2e.js
 * Optional: E2E_PHONE_RAW=9685722570 RAILWAY_RESOLVE_IP=66.33.22.247
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

function parseEnv(filePath) {
  try {
    return Object.fromEntries(
      fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
        .map(l => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
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
const PATIENT_FORM_HTML = fs.readFileSync(path.join(__dirname, '..', 'patient-form', 'index.html'), 'utf8');
const SB_ANON_KEY =
  env.SUPABASE_ANON_KEY ||
  (PATIENT_FORM_HTML.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/) || [])[1] ||
  '';

const PHONE_RAW = process.env.E2E_PHONE_RAW || '9685722570';
const PHONE_E164 = `+91${PHONE_RAW}`;
const HOSPITAL = process.env.E2E_HOSPITAL || 'VaitalCare E2E Hospital';
const DOCTOR = process.env.E2E_DOCTOR || 'Dr Ashu E2E';
const FACILITY = 'Pathology Lab';

let passed = 0;
let failed = 0;
const failures = [];
let clinicId = null;
let intakeToken = null;

function ok(msg) { console.log(`    ✅ ${msg}`); passed++; }
function section(t) { console.log(`\n${'─'.repeat(62)}\n  ${t}\n${'─'.repeat(62)}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function today(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().split('T')[0];
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const SB_HDR = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function sbGet(table, qs = '') {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, { headers: SB_HDR });
  return res.json().catch(() => []);
}

async function sbPost(table, body, qs = '') {
  const res = await fetch(`${SB_URL}/rest/v1/${table}${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: SB_HDR,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ _raw: '' }));
  if (!res.ok) {
    throw new Error(`${table} insert failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
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

async function sbDelete(table, filter) {
  await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: SB_HDR });
}

function curlJson(method, webhookPath, bodyObj) {
  const url = `${PROD_BASE}/webhook/${webhookPath}`;
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const args = [
    '-sS',
    '--resolve', `${RAILWAY_HOST}:443:${RAILWAY_IP}`,
    '-w', '\n__HTTP__%{http_code}',
    '-X', method,
    url,
    '-H', 'Content-Type: application/json',
  ];
  if (body) args.push('-d', body);
  const out = execSync(`curl ${args.map(a => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ')}`, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const idx = out.lastIndexOf('\n__HTTP__');
  const text = idx >= 0 ? out.slice(0, idx) : out;
  const status = idx >= 0 ? Number(out.slice(idx + 9)) : 0;
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status, json, text };
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
  const out = execSync(`curl ${args.map(a => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ')}`, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const idx = out.lastIndexOf('\n__HTTP__');
  const text = idx >= 0 ? out.slice(0, idx) : out;
  const status = idx >= 0 ? Number(out.slice(idx + 9)) : 0;
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status, json, text };
}

async function getPatient() {
  const rows = await sbGet('patients', `phone=eq.${encodeURIComponent(PHONE_E164)}&select=*`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getBoarding() {
  const rows = await sbGet('hospital_boarding',
    `hospital_name=eq.${encodeURIComponent(HOSPITAL)}&order=created_at.desc&select=*`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getDoctorProfile() {
  const rows = await sbGet('doctor_profiles',
    `doctor_phone=eq.${encodeURIComponent(PHONE_E164)}&select=*`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getLatestVisit(patientId) {
  const rows = await sbGet('patient_visits',
    `patient_id=eq.${encodeURIComponent(patientId)}&order=checked_in_at.desc&select=*&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function countVisitsForClinicDoctor(clinic, doctor, date) {
  const rows = await sbGet('patient_visits',
    `${clinicId ? `clinic_id=eq.${clinicId}&` : ''}clinic_name=eq.${encodeURIComponent(clinic)}&doctor_name=eq.${encodeURIComponent(doctor)}&visit_date=eq.${date}&visit_status=eq.waiting&select=id`);
  return Array.isArray(rows) ? rows.length : 0;
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function ensureQrClinicSeed() {
  const existing = await getBoarding();
  if (existing?.clinic_id) {
    clinicId = existing.clinic_id;
  } else {
    const slug = HOSPITAL.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    const code = slug.replace(/-/g, '').toUpperCase().slice(0, 10) || 'E2E';
    const clinics = await sbPost('clinics', {
      name: HOSPITAL,
      slug,
      code,
      status: 'active',
    }, 'on_conflict=slug');
    clinicId = clinics[0]?.id;
    assert(clinicId, `could not seed clinic: ${JSON.stringify(clinics)}`);

    await sbPost('hospital_boarding', {
      clinic_id: clinicId,
      hospital_name: HOSPITAL,
      facility_type: FACILITY,
      address: '42 E2E Test Lane, Bangalore',
      city: 'Bangalore',
      contact_phone: PHONE_RAW,
      admin_contact_name: 'E2E Admin',
      doctor_name: DOCTOR,
      doctor_qualification: 'MBBS',
      doctor_expertise: 'General Medicine',
      doctor_registration_number: 'E2E-REG-96857',
      doctor_phone: PHONE_E164,
      consultation_hours: 'Mon-Sat 9am-5pm',
    });
  }

  intakeToken = newToken();
  await sbPost('clinic_intake_tokens', {
    clinic_id: clinicId,
    token_hash: tokenHash(intakeToken),
    label: 'Production E2E QR',
    status: 'active',
  });

  return { clinicId, intakeToken };
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║     Production E2E — Patient / Hospital / Dashboard      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Railway   : ${PROD_BASE} (resolve ${RAILWAY_IP})`);
  console.log(`  Supabase  : ${SB_URL}`);
  console.log(`  Test phone: ${PHONE_RAW} → ${PHONE_E164}`);
  console.log(`  Clinic    : ${HOSPITAL} / ${DOCTOR}\n`);

  assert(SB_URL && SB_KEY, 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env');

  let visitIdBefore = null;
  let patientId = null;

  section('§1  Infrastructure');
  await test('1.1  Railway healthz', async () => {
    const out = execSync(
      `curl -sS --resolve '${RAILWAY_HOST}:443:${RAILWAY_IP}' -w '\\n__HTTP__%{http_code}' '${PROD_BASE}/healthz'`,
      { encoding: 'utf8' }
    );
    const idx = out.lastIndexOf('\n__HTTP__');
    const st = Number(out.slice(idx + 9));
    assert(st === 200, `healthz ${st}`);
    const body = JSON.parse(out.slice(0, idx));
    assert(body.status === 'ok', JSON.stringify(body));
  });

  await test('1.2  WF11 empty body returns 400 validation', async () => {
    const { status, json } = curlJson('POST', 'patient-form-intake', {});
    assert(status === 400, `expected 400, got ${status}`);
    assert(json.status === 'error', JSON.stringify(json));
    assert(Array.isArray(json.errors) && json.errors.length > 0, 'missing errors[]');
  });

  await test('1.3  Supabase multitenant QR RPC is deployed', async () => {
    assert(SB_ANON_KEY, 'SUPABASE_ANON_KEY required in .env or patient-form/index.html');
    const res = await sbRpc('resolve_public_intake_token', { p_token: '0'.repeat(64) }, SB_ANON_KEY);
    assert(res.status !== 404, `resolve_public_intake_token missing: ${JSON.stringify(res.json)}`);
    assert(res.ok, `resolve_public_intake_token failed (${res.status}): ${JSON.stringify(res.json)}`);
    assert(Array.isArray(res.json), `expected array response, got ${JSON.stringify(res.json)}`);
  });

  section('§2  WF12 — Hospital boarding (doctor username/password login)');
  const boardingPayload = {
    hospital_name: HOSPITAL,
    facility_type: FACILITY,
    address: '42 E2E Test Lane, Bangalore',
    city: 'Bangalore',
    contact_phone: PHONE_RAW,
    admin_contact_name: 'E2E Admin',
    clinic_logo_url: '',
    clinic_email: 'e2e@vaitalcare.test',
    clinic_website: 'https://vaitalcare.example',
    doctor_name: DOCTOR,
    doctor_qualification: 'MBBS',
    doctor_expertise: 'General Medicine',
    doctor_registration_number: 'E2E-REG-96857',
    doctor_phone: PHONE_E164,
    doctor_signature_url: '',
    consultation_hours: 'Mon-Sat 9am-5pm',
  };
  boardingPayload.doctor_count = '1';
  boardingPayload.login_username = 'e2e.doctor';
  boardingPayload.doctors_json = JSON.stringify([{
    doctor_name: boardingPayload.doctor_name,
    doctor_qualification: boardingPayload.doctor_qualification,
    doctor_expertise: boardingPayload.doctor_expertise,
    doctor_registration_number: boardingPayload.doctor_registration_number,
    doctor_phone: boardingPayload.doctor_phone,
    doctor_signature_url: boardingPayload.doctor_signature_url,
    login_username: boardingPayload.login_username,
    password: 'E2ePass123',
  }]);

  await test('2.1  Valid hospital boarding (form-encoded like UI)', async () => {
    await sbDelete('hospital_boarding', `hospital_name=eq.${encodeURIComponent(HOSPITAL)}`).catch(() => {});
    const { status, json } = curlForm('hospital-boarding', boardingPayload);
    assert(status === 200, `status ${status}: ${JSON.stringify(json)}`);
    assert(json.status === 'success', JSON.stringify(json));
    assert(json.hospital_name === HOSPITAL, JSON.stringify(json));
  });

  await test('2.2  Boarding row in Supabase with doctor_phone', async () => {
    await sleep(1500);
    const row = await getBoarding();
    assert(row, 'hospital_boarding row missing');
    assert(row.doctor_phone === PHONE_E164 || row.doctor_phone === PHONE_RAW,
      `doctor_phone mismatch: ${row.doctor_phone}`);
    assert(row.doctor_name === DOCTOR, `doctor_name: ${row.doctor_name}`);
  });

  await test('2.4  Seed/verify clinic QR token for patient intake', async () => {
    await ensureQrClinicSeed();
    assert(/^[0-9a-f-]{36}$/i.test(clinicId), `invalid clinic_id ${clinicId}`);
    assert(/^[a-f0-9]{64}$/.test(intakeToken), 'invalid intake token');
  });

  await test('2.3  Edge: invalid facility_type → 400', async () => {
    const { status, json } = curlForm('hospital-boarding', {
      ...boardingPayload,
      hospital_name: `${HOSPITAL} Invalid`,
      facility_type: 'Veterinary Clinic',
    });
    assert(status === 400, `expected 400, got ${status}`);
    assert(Array.isArray(json.errors), JSON.stringify(json));
  });

  section('§3  WF11 — Patient intake (happy path + edge cases)');
  const baseIntake = {
    patient_name: 'Dummy Test Patient',
    phone_number: PHONE_RAW,
    dob: '1990-01-15',
    sex: 'Male',
    hospital_name: HOSPITAL,
    doctor_name: DOCTOR,
    clinic_mode: 'shared_qr',
    visit_date: today(0),
    follow_up_required: 'No',
    follow_up_date: '',
  };

  await test('3.1  Valid intake (URL-encoded like patient form)', async () => {
    const patBefore = await getPatient();
    patientId = patBefore?.id;
    const { status, json } = curlForm('patient-form-intake', baseIntake);
    assert(status === 200, `status ${status}: ${JSON.stringify(json)}`);
    assert(json.status === 'success', JSON.stringify(json));
    assert(/^PAT-\d{4}$/.test(json.patient_code || ''), `patient_code: ${json.patient_code}`);
    assert(json.visit_id, `visit_id missing: ${JSON.stringify(json)}`);
    visitIdBefore = json.visit_id;
    await sleep(2000);
    const pat = await getPatient();
    assert(pat, 'patient not in Supabase');
    patientId = pat.id;
    assert(pat.phone === PHONE_E164, `phone ${pat.phone}`);
    const visit = await getLatestVisit(pat.id);
    assert(visit?.id === visitIdBefore || visit?.clinic_name === HOSPITAL,
      `latest visit mismatch: ${JSON.stringify(visit)}`);
    assert(visit.visit_status === 'waiting', `status ${visit.visit_status}`);
  });

  await test('3.2  Edge: future visit_date → 400', async () => {
    const { status, json } = curlForm('patient-form-intake', {
      ...baseIntake,
      patient_name: 'Future Visit',
      visit_date: today(2),
    });
    assert(status === 400, `expected 400, got ${status}`);
    assert((json.errors || []).some(e => e.includes('visit_date')), JSON.stringify(json));
  });

  await test('3.3  Edge: follow-up date not after visit → 400', async () => {
    const vd = today(-2);
    const { status, json } = curlForm('patient-form-intake', {
      ...baseIntake,
      patient_name: 'Bad Followup',
      visit_date: vd,
      follow_up_required: 'Yes',
      follow_up_date: vd,
    });
    assert(status === 400, `expected 400, got ${status}`);
    assert((json.errors || []).some(e => e.includes('follow_up_date')), JSON.stringify(json));
  });

  await test('3.4  Re-registration updates doctor and creates new visit', async () => {
    const { status, json } = curlForm('patient-form-intake', {
      ...baseIntake,
      patient_name: 'E2E Prod Patient Updated',
      doctor_name: DOCTOR,
      follow_up_required: 'Yes',
      follow_up_date: today(7),
    });
    assert(status === 200, `${status} ${JSON.stringify(json)}`);
    await sleep(2000);
    const pat = await getPatient();
    assert(pat.name.includes('Updated') || pat.name === 'E2E Prod Patient Updated',
      `name not updated: ${pat.name}`);
    assert(pat.follow_up_required === 'Yes', `follow_up ${pat.follow_up_required}`);
  });

  section('§4  Dashboard data path (RLS + profile bootstrap)');
  await test('4.1  hospital_boarding enables doctor profile bootstrap', async () => {
    const boarding = await getBoarding();
    assert(boarding, 'boarding missing');
    assert(
      boarding.doctor_phone === PHONE_E164
        || boarding.doctor_phone.replace(/\s/g, '') === PHONE_E164,
      `boarding doctor_phone ${boarding.doctor_phone}`
    );
  });

  await test('4.2  Waiting visits exist for clinic+doctor (dashboard queue match)', async () => {
    const n = await countVisitsForClinicDoctor(HOSPITAL, DOCTOR, today(0));
    assert(n >= 1, `expected ≥1 waiting visit for ${HOSPITAL}/${DOCTOR} today, got ${n}`);
  });

  await test('4.3  get_public_hospital_list includes E2E hospital', async () => {
    const anon = SB_ANON_KEY;
    assert(anon, 'SUPABASE_ANON_KEY required');
    const res = await fetch(`${SB_URL}/rest/v1/rpc/get_public_hospital_list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anon },
    });
    const list = await res.json();
    assert(Array.isArray(list), `unexpected RPC response: ${JSON.stringify(list)}`);
    const names = list.map(r => r.hospital_name || r.name || r.clinic_name).filter(Boolean);
    const found = names.some(n => String(n).toLowerCase() === HOSPITAL.toLowerCase())
      || list.some(r => Object.values(r).some(v => String(v).toLowerCase() === HOSPITAL.toLowerCase()));
    assert(found, `hospital not in public list. Sample: ${JSON.stringify(list.slice(0, 5))}`);
  });

  section('Summary');
  console.log(`\n  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  if (failures.length) {
    console.log('\n  Failures:');
    failures.forEach((f, i) => console.log(`    ${i + 1}. ${f.label}\n       ${f.detail}`));
  }
  console.log('\n  Doctor dashboard: open deployed URL, sign in with username e2e.doctor and the configured E2E password.\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
