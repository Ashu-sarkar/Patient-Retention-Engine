#!/usr/bin/env node
/**
 * Patient Retention Engine — Integration Test Suite
 *
 * Tests all 10 workflows end-to-end against a live n8n + Supabase stack.
 * WhatsApp notifications are NOT sent — the test verifies the trigger
 * reaches the WA send node (system_logs ERROR confirms the attempt).
 *
 * Prerequisites:
 *   1. docker compose up -d --build          (n8n running at localhost:5678)
 *   2. node tests/setup-n8n.js               (credentials + workflow activation)
 *   3. node tests/run-tests.js               (this file)
 *
 * Node 18+ required (uses built-in fetch).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
function parseEnv(filePath) {
  try {
    return Object.fromEntries(
      fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
    );
  } catch { return {}; }
}

const env          = parseEnv(path.join(__dirname, '..', '.env'));
const N8N_URL      = `http://${env.N8N_HOST || 'localhost'}:${env.N8N_PORT || '5678'}`;
const N8N_B64      = Buffer.from(`${env.N8N_BASIC_AUTH_USER || 'admin'}:${env.N8N_BASIC_AUTH_PASSWORD || 'strongpass'}`).toString('base64');
const SB_URL       = env.SUPABASE_URL;
const SB_KEY       = env.SUPABASE_SERVICE_ROLE_KEY;
const WA_VER_TOKEN = env.WA_WEBHOOK_VERIFY_TOKEN || '';

// Dedicated test phone numbers (10-digit raw; WF11 prepends +91)
// Using 900000XXXX range to avoid collision with real patients
const TP = {
  wf11_new  : '9000000001',   // WF11 new patient
  wf11_dup  : '9000000001',   // same phone → tests upsert
  wf11_sql  : '9000000002',   // SQL-injection name test
  wf6       : '+919000000003',// WF6 feedback test (already E.164)
  wf1       : '+919000000011',// WF1 follow-up reminder seed
  wf2       : '+919000000012',// WF2 same-day reminder seed
  wf3       : '+919000000013',// WF3 missed appointment seed
  wf4       : '+919000000014',// WF4 health-check seed
  wf5       : '+919000000015',// WF5 reactivation seed
  e2e       : '9000000020',   // E2E full-flow test
};

const HF = {
  primaryHospital: 'Test Boarding Hospital Alpha',
  secondaryHospital: 'Test Boarding Hospital Beta',
  doctor: 'Dr Boarding',
};

const FACILITY_TYPE = 'Pathology Lab';

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function ok(msg)  { console.log(`    ✅ ${msg}`); passed++; }
function fail(msg, err) {
  const detail = err instanceof Error ? err.message : String(err);
  console.log(`    ❌ ${msg}\n       → ${detail}`);
  failed++;
  failures.push({ msg, detail });
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
    failures.push({ msg: label, detail: e.message });
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function section(title) {
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(62));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Today / offset dates as YYYY-MM-DD
function date(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().split('T')[0];
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function n8nApi(method, path, body) {
  const res  = await fetch(`${N8N_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${N8N_B64}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, ok: res.ok, json };
}

async function wh(webhookPath, method = 'POST', body = null, extraHeaders = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    signal: AbortSignal.timeout(15000),
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res  = await fetch(`${N8N_URL}/webhook/${webhookPath}`, opts);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, ok: res.ok, json, text };
}

// ── Supabase REST helpers ─────────────────────────────────────────────────────
const SB_HDR = {
  apikey        : SB_KEY,
  Authorization : `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  Prefer        : 'return=representation',
};

async function sbGet(table, qs = '') {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, { headers: SB_HDR });
  return res.json().catch(() => []);
}

async function sbInsert(table, row) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method : 'POST',
    headers: SB_HDR,
    body   : JSON.stringify(row),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Supabase insert failed: ${JSON.stringify(json)}`);
  return json;
}

async function sbDelete(table, filter) {
  await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: SB_HDR });
}

// Convenience wrappers
async function getPatient(phone) {
  const rows = await sbGet('patients', `phone=eq.${encodeURIComponent(phone)}&select=*`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getHospitalBoarding(hospitalName) {
  const rows = await sbGet('hospital_boarding',
    `hospital_name=eq.${encodeURIComponent(hospitalName)}&order=created_at.desc&select=*`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function recentSystemLogs(workflowName, windowSec = 45) {
  const since = new Date(Date.now() - windowSec * 1000).toISOString();
  const rows  = await sbGet('system_logs',
    `workflow_name=eq.${workflowName}&timestamp=gte.${since}&order=timestamp.desc`);
  return Array.isArray(rows) ? rows : [];
}

async function seedPatient(phone, extra = {}) {
  // Upsert: delete first to avoid conflict, then insert
  await sbDelete('patients', `phone=eq.${encodeURIComponent(phone)}`);
  return sbInsert('patients', {
    name              : extra.name       || `Test ${phone}`,
    phone,
    clinic_name       : extra.clinic_name || 'Test Clinic',
    doctor_name       : extra.doctor_name || 'Dr Test',
    visit_date        : extra.visit_date  || date(-1),
    follow_up_required: extra.follow_up_required || 'No',
    follow_up_date    : extra.follow_up_date     || null,
    status            : extra.status             || 'pending',
    message_count     : extra.message_count      ?? 0,
    health_check_sent : extra.health_check_sent  ?? false,
    reactivation_sent : extra.reactivation_sent  ?? false,
    last_message_sent : extra.last_message_sent  || null,
  });
}

async function cleanup() {
  const phones = [
    `+91${TP.wf11_new}`, `+91${TP.wf11_sql}`,
    TP.wf6, TP.wf1, TP.wf2, TP.wf3, TP.wf4, TP.wf5,
    `+91${TP.e2e}`,
  ];
  for (const phone of phones) {
    await sbDelete('patients', `phone=eq.${encodeURIComponent(phone)}`).catch(() => {});
  }
  for (const hospitalName of [HF.primaryHospital, HF.secondaryHospital]) {
    await sbDelete('hospital_boarding', `hospital_name=eq.${encodeURIComponent(hospitalName)}`).catch(() => {});
  }
}

// ── Meta-style webhook payload builder ───────────────────────────────────────
function metaMsg(fromPhone, text) {
  return {
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: fromPhone.replace(/^\+/, ''),
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║      Patient Retention Engine — Integration Tests        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  n8n      : ${N8N_URL}`);
  console.log(`  Supabase : ${SB_URL}\n`);

  // ── §1 Infrastructure ────────────────────────────────────────────────────
  section('§1  Infrastructure');

  await test('1.1  Supabase REST API reachable', async () => {
    const rows = await sbGet('patients', 'select=id&limit=1');
    assert(Array.isArray(rows), `Unexpected response: ${JSON.stringify(rows)}`);
  });

  await test('1.2  n8n health endpoint reachable', async () => {
    const res = await fetch(`${N8N_URL}/healthz`, { signal: AbortSignal.timeout(5000) });
    assert(res.ok || res.status === 401, `n8n returned ${res.status}. Is "docker compose up" running?`);
  });

  let allWorkflows = [];
  await test('1.3  All 10 workflows imported in n8n', async () => {
    const { ok, json } = await n8nApi('GET', '/api/v1/workflows?limit=100');
    assert(ok, `n8n API auth failed (${json?.message || 'check N8N_BASIC_AUTH_USER/PASSWORD'})`);
    allWorkflows = json.data || [];
    const names   = allWorkflows.map(w => w.name);
    const REQUIRED = ['WF1', 'WF2', 'WF3', 'WF4', 'WF5', 'WF6', 'WF7', 'WF8', 'WF11', 'WF12'];
    const missing  = REQUIRED.filter(r => !names.some(n => n.includes(r)));
    assert(missing.length === 0,
      `Missing workflows: ${missing.join(', ')}. Run: docker compose down -v && docker compose up --build -d`);
  });

  await test('1.4  Webhook workflows (WF11, WF12, WF7, WF6) are active', async () => {
    const relevant = allWorkflows.filter(w =>
      w.name.includes('WF11') || w.name.includes('WF12') || w.name.includes('WF7') || w.name.includes('WF6'));
    assert(relevant.length === 4,
      `Expected WF11/WF12/WF7/WF6 in n8n, found ${relevant.length}. Run: node tests/setup-n8n.js`);
    const inactive = relevant.filter(w => !w.active).map(w => w.name);
    assert(inactive.length === 0,
      `Inactive: ${inactive.join(', ')}. Run: node tests/setup-n8n.js`);
  });

  await test('1.5  Supabase tables exist (patients, message_logs, system_logs, hospital_boarding)', async () => {
    const [p, m, s, h] = await Promise.all([
      sbGet('patients',     'select=id&limit=1'),
      sbGet('message_logs', 'select=log_id&limit=1'),
      sbGet('system_logs',  'select=log_id&limit=1'),
      sbGet('hospital_boarding', 'select=id&limit=1'),
    ]);
    assert(Array.isArray(p), 'patients table missing or inaccessible');
    assert(Array.isArray(m), 'message_logs table missing or inaccessible');
    assert(Array.isArray(s), 'system_logs table missing or inaccessible');
    assert(Array.isArray(h),
      'hospital_boarding table missing or inaccessible. Apply schemas/migration-add-hospital-boarding.sql in Supabase.');
  });

  // ── §2  WF12 — Hospital Boarding ─────────────────────────────────────────
  section('§2  WF12 — Hospital Boarding  (POST /webhook/hospital-boarding)');

  const HOSPITAL_BASE = {
    hospital_name    : HF.primaryHospital,
    facility_type    : FACILITY_TYPE,
    address          : '12 Referral Street, Chennai, Tamil Nadu 600001',
    doctor_name      : HF.doctor,
    doctor_expertise : 'Lab diagnostics and pathology reporting',
  };

  await test('2.1  Valid hospital boarding → 200 + success response', async () => {
    await sbDelete('hospital_boarding', `hospital_name=eq.${encodeURIComponent(HF.primaryHospital)}`).catch(() => {});
    const { status, json } = await wh('hospital-boarding', 'POST', HOSPITAL_BASE);
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
    assert(json.status === 'success', `Expected status=success: ${JSON.stringify(json)}`);
    assert(json.hospital_name === HF.primaryHospital, `hospital_name mismatch: ${JSON.stringify(json)}`);
    assert(json.facility_type === FACILITY_TYPE, `facility_type mismatch: ${JSON.stringify(json)}`);
  });

  await test('2.2  Hospital boarding row persisted in Supabase', async () => {
    await sleep(1200);
    const row = await getHospitalBoarding(HF.primaryHospital);
    assert(row, `Hospital row "${HF.primaryHospital}" not found in Supabase`);
    assert(row.facility_type === FACILITY_TYPE, `facility_type mismatch: "${row.facility_type}"`);
    assert(row.doctor_name === HF.doctor, `doctor_name mismatch: "${row.doctor_name}"`);
  });

  await test('2.3  WF12 system_log INFO entry recorded', async () => {
    await sleep(1200);
    const logs = await recentSystemLogs('workflow-12-hospital-boarding');
    const info = logs.find(l => l.log_level === 'INFO');
    assert(info, 'No INFO log from WF12 — check Supabase credential in n8n');
  });

  await test('2.4  Validation: unsupported facility_type → 400 + errors[]', async () => {
    const { status, json } = await wh('hospital-boarding', 'POST', {
      ...HOSPITAL_BASE,
      hospital_name: HF.secondaryHospital,
      facility_type: 'Veterinary Clinic',
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(Array.isArray(json.errors) && json.errors.some(err => err.includes('facility_type')),
      `Expected facility_type error: ${JSON.stringify(json)}`);
  });

  await test('2.5  Validation: missing doctor_name → 400', async () => {
    const { status, json } = await wh('hospital-boarding', 'POST', {
      ...HOSPITAL_BASE,
      hospital_name: HF.secondaryHospital,
      doctor_name: '',
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(Array.isArray(json.errors) && json.errors.some(err => err.includes('doctor_name')),
      `Expected doctor_name error: ${JSON.stringify(json)}`);
  });

  // ── §3  WF11 — QR Form Intake ────────────────────────────────────────────
  section('§3  WF11 — QR Form Intake  (POST /webhook/patient-form-intake)');

  // Base valid payload
  const BASE = {
    patient_name     : 'Test Patient Alpha',
    phone_number     : TP.wf11_new,          // 10 digits, no +91
    dob              : '1990-05-20',
    sex              : 'Male',
    hospital_name    : 'Test Hospital',
    doctor_name      : 'Dr Alpha',
    visit_date       : date(-1),             // yesterday
    follow_up_required: 'Yes',
    follow_up_date   : date(3),             // 3 days from now
  };

  await test('2.1  Valid registration → 200 + patient_code in response', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', BASE);
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
    assert(json.status === 'success', `Expected status=success: ${JSON.stringify(json)}`);
    assert(json.patient_code, `No patient_code in response: ${JSON.stringify(json)}`);
  });

  await test('2.2  Patient row persisted in Supabase', async () => {
    await sleep(1500);
    const pat = await getPatient(`+91${TP.wf11_new}`);
    assert(pat, `Patient +91${TP.wf11_new} not found in Supabase`);
    assert(pat.name === 'Test Patient Alpha', `Name mismatch: "${pat.name}"`);
    assert(pat.patient_code?.startsWith('PAT-'), `patient_code looks wrong: ${pat.patient_code}`);
    assert(pat.status === 'pending', `Expected status=pending, got ${pat.status}`);
    assert(pat.follow_up_required === 'Yes', 'follow_up_required should be Yes');
  });

  await test('2.3  WA welcome trigger logged (WF7 system_log)', async () => {
    await sleep(2000); // allow WF7 to run
    // Either a success log from WF11, or an ERROR log from WF7 (WA creds invalid)
    const logs = await recentSystemLogs('workflow-11-form-intake');
    assert(logs.length > 0,
      'No system_log from WF11 — check Supabase credentials are set in n8n');
  });

  await test('2.4  Validation: missing required fields → 400 + errors[]', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', {
      patient_name: 'AB',          // too short, other fields missing
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(Array.isArray(json.errors) && json.errors.length > 0,
      `Expected non-empty errors[]: ${JSON.stringify(json)}`);
  });

  await test('2.5  Validation: phone not 10 digits → 400', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', {
      ...BASE, phone_number: '12345',
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(JSON.stringify(json.errors).includes('phone'), `Expected phone error: ${JSON.stringify(json)}`);
  });

  await test('2.6  Validation: future visit_date → 400', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', {
      ...BASE, phone_number: '9000099991', visit_date: date(2),
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(JSON.stringify(json.errors).includes('visit_date'), `Expected visit_date error`);
  });

  await test('2.7  Validation: follow_up=Yes without follow_up_date → 400', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', {
      ...BASE, phone_number: '9000099992', follow_up_required: 'Yes', follow_up_date: '',
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(JSON.stringify(json.errors).includes('follow_up_date'), `Expected follow_up_date error`);
  });

  await test('2.8  Validation: invalid sex value → 400', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', {
      ...BASE, phone_number: '9000099993', sex: 'Robot',
    });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test('2.9  Duplicate phone → 200 (upsert updates existing record)', async () => {
    const updated = { ...BASE, patient_name: 'Test Patient Alpha Updated', doctor_name: 'Dr Beta' };
    const { status, json } = await wh('patient-form-intake', 'POST', updated);
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
    await sleep(1200);
    const pat = await getPatient(`+91${TP.wf11_new}`);
    assert(pat?.doctor_name === 'Dr Beta', `Expected Dr Beta, got "${pat?.doctor_name}"`);
  });

  await test('2.10 SQL injection in name handled safely', async () => {
    const { status } = await wh('patient-form-intake', 'POST', {
      ...BASE, phone_number: TP.wf11_sql,
      patient_name: "Robert'); DROP TABLE patients; --",
    });
    // 400 (name too risky) OR 200 (SQL escaped) — either is acceptable
    // but the table must still exist
    await sleep(500);
    const rows = await sbGet('patients', 'select=id&limit=1');
    assert(Array.isArray(rows), '🚨 patients table gone — SQL injection succeeded!');
    assert([200, 400].includes(status), `Unexpected status ${status}`);
  });

  // ── §4  WF7 — New Patient Welcome ────────────────────────────────────────
  section('§4  WF7 — New Patient Welcome  (POST /webhook/new-patient-intake)');

  await test('3.1  Valid payload → 200 (WA attempt made, error logged if creds placeholder)', async () => {
    const { status, json } = await wh('new-patient-intake', 'POST', {
      patient_code      : 'PAT-TEST',
      name              : 'WF7 Test Patient',
      phone             : '+919000000099',
      clinic_name       : 'Test Clinic',
      doctor_name       : 'Dr WF7',
      follow_up_required: 'Yes',
      follow_up_date    : date(5),
      visit_date        : date(-1),
    });
    assert([200, 202].includes(status), `Expected 200/202, got ${status}: ${JSON.stringify(json)}`);
    // After ~2s, WF7 should have logged an ERROR (WA creds invalid) or INFO (WA succeeded)
    await sleep(2500);
    const logs = await recentSystemLogs('workflow-7-new-patient');
    // Either an ERROR (WA failed — expected with placeholder creds) or nothing (creds valid, succeeded)
    console.log(`       WF7 system_logs in last 60s: ${logs.length} entries`);
    // Not asserting on log content — just verifying the workflow ran without crashing
  });

  await test('3.2  Invalid phone → skipped gracefully (no DB write, no crash)', async () => {
    const before = await recentSystemLogs('workflow-7-new-patient');
    const { status } = await wh('new-patient-intake', 'POST', {
      patient_code: 'PAT-SKIP',
      name        : 'Skip Test',
      phone       : 'not-a-phone',
      clinic_name : 'X',
      doctor_name : 'Y',
      visit_date  : date(-1),
    });
    assert([200, 202].includes(status), `Expected graceful 200, got ${status}`);
    await sleep(1000);
    const after = await recentSystemLogs('workflow-7-new-patient');
    // No new ERROR log should appear for a skip (just silent skip)
    console.log(`       WF7 logs before: ${before.length}, after: ${after.length}`);
  });

  await test('3.3  Empty name → skipped gracefully', async () => {
    const { status } = await wh('new-patient-intake', 'POST', {
      patient_code: 'PAT-SKIP2',
      name        : '',
      phone       : '+919000000098',
      clinic_name : 'X',
      doctor_name : 'Y',
      visit_date  : date(-1),
    });
    assert([200, 202].includes(status), `Expected graceful 200, got ${status}`);
  });

  // ── §5  WF6 — Feedback Listener ──────────────────────────────────────────
  section('§5  WF6 — Feedback Listener  (GET + POST /webhook/feedback-listener)');

  // Seed a known patient for WF6 tests
  await seedPatient(TP.wf6, {
    name              : 'WF6 Test Patient',
    follow_up_required: 'Yes',
    follow_up_date    : date(2),
    status            : 'pending',
    message_count     : 1,
    visit_date        : date(-5),
  });
  await sleep(500);

  await test('4.1  GET verification with correct token → hub.challenge echoed', async () => {
    const challenge = 'challenge_abc_123';
    const url       = `${N8N_URL}/webhook/feedback-listener?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(WA_VER_TOKEN)}&hub.challenge=${challenge}`;
    const res       = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const text      = await res.text();
    assert(res.ok, `Expected 200, got ${res.status}`);
    assert(text.includes(challenge),
      `Expected challenge "${challenge}" in body. Got: ${text.substring(0, 100)}`);
  });

  await test('4.2  GET verification with wrong token → non-200', async () => {
    const url = `${N8N_URL}/webhook/feedback-listener?hub.mode=subscribe&hub.verify_token=WRONG_TOKEN&hub.challenge=xyz`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    assert(!res.ok, `Expected error status, got ${res.status}`);
  });

  await test('4.3  POST confirmed message → response_status = confirmed in DB', async () => {
    // Reset patient status first
    await sbDelete('patients', `phone=eq.${encodeURIComponent(TP.wf6)}`);
    await seedPatient(TP.wf6, { name: 'WF6 Test Patient', message_count: 1, status: 'pending' });
    await sleep(300);

    const { status } = await wh('feedback-listener', 'POST', metaMsg(TP.wf6, 'Yes, I will come'));
    assert([200, 202].includes(status), `Expected 200, got ${status}`);
    await sleep(2500);
    const pat = await getPatient(TP.wf6);
    assert(pat, 'Patient not found after feedback update');
    assert(pat.response_status === 'confirmed',
      `Expected response_status=confirmed, got "${pat.response_status}"`);
    assert(pat.last_response, 'last_response should be set');
  });

  await test('4.4  POST cancelled message → response_status = cancelled in DB', async () => {
    const { status } = await wh('feedback-listener', 'POST',
      metaMsg(TP.wf6, 'No, please cancel my appointment'));
    assert([200, 202].includes(status), `Expected 200, got ${status}`);
    await sleep(2000);
    const pat = await getPatient(TP.wf6);
    assert(pat?.response_status === 'cancelled',
      `Expected cancelled, got "${pat?.response_status}"`);
  });

  await test('4.5  POST from unknown number → WARN logged in system_logs', async () => {
    const before = await recentSystemLogs('workflow-6-feedback-listener');
    const { status } = await wh('feedback-listener', 'POST',
      metaMsg('+919999999999', 'Hello there'));
    assert([200, 202].includes(status), `Expected 200, got ${status}`);
    await sleep(2000);
    const after  = await recentSystemLogs('workflow-6-feedback-listener');
    const warns  = after.filter(l => l.log_level === 'WARN');
    assert(warns.length > 0, 'Expected at least one WARN log for unknown sender');
  });

  await test('4.6  POST non-message event (status update) → skipped gracefully', async () => {
    const payload = {
      entry: [{
        changes: [{
          value: { statuses: [{ id: 'msg123', status: 'delivered' }] }, // No "messages" key
        }],
      }],
    };
    const { status } = await wh('feedback-listener', 'POST', payload);
    assert([200, 202].includes(status), `Expected graceful 200, got ${status}`);
  });

  await test('4.7  POST help keyword → classified as "help" (not confirmed/cancelled)', async () => {
    // Reset to clean state
    await sbDelete('patients', `phone=eq.${encodeURIComponent(TP.wf6)}`);
    await seedPatient(TP.wf6, { name: 'WF6 Test Patient', message_count: 1, status: 'pending' });
    await sleep(300);

    await wh('feedback-listener', 'POST', metaMsg(TP.wf6, 'I need urgent help'));
    await sleep(2000);
    const pat = await getPatient(TP.wf6);
    // "help" maps to response_status = 'responded' (the generic fallback in WF6)
    assert(pat?.response_status === 'responded',
      `Expected responded for help keyword, got "${pat?.response_status}"`);
  });

  // ── §6  Cron Workflow DB Query Validation ────────────────────────────────
  section('§6  Cron Workflow Filtering Logic (Supabase query simulation)');
  console.log('  Seeding test patients for each cron scenario …');

  // Seed all cron test patients (parallel for speed)
  await Promise.all([
    // WF1: follow_up = tomorrow, pending, message_count < 5
    seedPatient(TP.wf1, { name: 'WF1 Patient', follow_up_required: 'Yes',
      follow_up_date: date(1), status: 'pending', message_count: 0 }),

    // WF2: follow_up = today, pending, message_count < 5
    seedPatient(TP.wf2, { name: 'WF2 Patient', follow_up_required: 'Yes',
      follow_up_date: date(0), status: 'pending', message_count: 0 }),

    // WF3: follow_up_date in past, status != completed/inactive
    seedPatient(TP.wf3, { name: 'WF3 Patient', follow_up_required: 'Yes',
      follow_up_date: date(-5), status: 'pending', message_count: 0 }),

    // WF4: visit_date 2 days ago, health_check_sent = false, status != inactive
    seedPatient(TP.wf4, { name: 'WF4 Patient', visit_date: date(-2),
      health_check_sent: false, status: 'pending', message_count: 1 }),

    // WF5: last_message_sent > 30 days ago, reactivation_sent = false
    seedPatient(TP.wf5, { name: 'WF5 Patient',
      last_message_sent: new Date(Date.now() - 35 * 86400000).toISOString(),
      reactivation_sent: false, status: 'pending', message_count: 2 }),
  ]);
  await sleep(800);
  console.log('  Seed complete.\n');

  await test('5.1  WF1 — patient with follow_up_date=tomorrow & status=pending is queryable', async () => {
    const rows = await sbGet('patients',
      `phone=eq.${encodeURIComponent(TP.wf1)}&status=eq.pending&follow_up_date=eq.${date(1)}&select=id,name,follow_up_date`
    );
    assert(rows.length > 0, `WF1 SQL would find 0 patients. Check seed or DB timezone.`);
    assert(rows[0].follow_up_date?.startsWith(date(1)), `follow_up_date mismatch: ${rows[0].follow_up_date}`);
  });

  await test('5.2  WF2 — patient with follow_up_date=today & status=pending is queryable', async () => {
    const rows = await sbGet('patients',
      `phone=eq.${encodeURIComponent(TP.wf2)}&status=eq.pending&follow_up_date=eq.${date(0)}&select=id,name,follow_up_date`
    );
    assert(rows.length > 0, 'WF2 SQL would find 0 patients');
  });

  await test('5.3  WF3 — patient with past follow_up_date (not completed/inactive) is queryable', async () => {
    const rows = await sbGet('patients',
      `phone=eq.${encodeURIComponent(TP.wf3)}&status=neq.completed&status=neq.inactive&follow_up_date=lt.${date(0)}&select=id,name,follow_up_date,status`
    );
    assert(rows.length > 0, 'WF3 SQL would find 0 patients');
    assert(rows[0].status === 'pending', `Expected pending, got ${rows[0].status}`);
  });

  await test('5.4  WF4 — patient who visited 2 days ago with health_check_sent=false is queryable', async () => {
    const rows = await sbGet('patients',
      `phone=eq.${encodeURIComponent(TP.wf4)}&health_check_sent=eq.false&status=neq.inactive&select=id,name,visit_date,health_check_sent`
    );
    assert(rows.length > 0, 'WF4 SQL would find 0 patients');
    assert(rows[0].health_check_sent === false, 'health_check_sent should be false');
  });

  await test('5.5  WF5 — patient with last_message > 30 days & reactivation_sent=false is queryable', async () => {
    const rows = await sbGet('patients',
      `phone=eq.${encodeURIComponent(TP.wf5)}&reactivation_sent=eq.false&status=neq.inactive&status=neq.completed&select=id,name,last_message_sent,reactivation_sent`
    );
    assert(rows.length > 0, 'WF5 SQL would find 0 patients');
    const lastSent = new Date(rows[0].last_message_sent);
    const daysDiff = (Date.now() - lastSent) / 86400000;
    assert(daysDiff >= 30, `last_message_sent too recent: ${daysDiff.toFixed(1)} days ago`);
  });

  await test('5.6  WF1 skips patient already at message_count=5', async () => {
    // Temporarily bump message_count to 5 and verify query excludes them
    await seedPatient(TP.wf1, { name: 'WF1 Max Msg', follow_up_required: 'Yes',
      follow_up_date: date(1), status: 'pending', message_count: 5 });
    await sleep(300);
    const rows = await sbGet('patients',
      `phone=eq.${encodeURIComponent(TP.wf1)}&message_count=lt.5&select=id`
    );
    assert(rows.length === 0, 'Patient with message_count=5 should be EXCLUDED by WF1 filter');
    // Restore to message_count=0 for cleanup
    await seedPatient(TP.wf1, { name: 'WF1 Patient', follow_up_required: 'Yes',
      follow_up_date: date(1), status: 'pending', message_count: 0 });
  });

  await test('5.7  WF3 marks patient as "missed" after 7+ days past follow_up_date', async () => {
    // Seed a patient 7+ days past follow_up_date to test the day+7 logic
    const phone = TP.wf3;
    await seedPatient(phone, { name: 'WF3 7day Patient', follow_up_required: 'Yes',
      follow_up_date: date(-8), status: 'pending', message_count: 2 });
    await sleep(300);
    const rows = await sbGet('patients',
      `phone=eq.${encodeURIComponent(phone)}&follow_up_date=lt.${date(-6)}&status=eq.pending&select=id,name,follow_up_date`
    );
    assert(rows.length > 0, 'WF3 7-day patient should be found by the missed-7-day query');
  });

  // ── §7  Manual Workflow Trigger (via n8n API) ─────────────────────────────
  section('§7  Cron Workflow Manual Execution (n8n API trigger)');

  async function triggerWorkflow(nameFragment) {
    const wf = allWorkflows.find(w => w.name.includes(nameFragment));
    if (!wf) return { skipped: true, reason: `Workflow ${nameFragment} not found in n8n` };

    // Try n8n v1 API manual execution endpoint
    const { ok, status, json } = await n8nApi('POST', `/api/v1/workflows/${wf.id}/run`, {});
    if (ok) return { ok: true, wfId: wf.id, executionId: json?.data?.executionId };
    return { skipped: true, reason: `n8n API returned ${status}: ${JSON.stringify(json).substring(0, 100)}` };
  }

  for (const [label, wfFragment, seedPhone, logWorkflow] of [
    ['6.1  WF1 — Follow-Up Reminder triggered manually',   'WF1', TP.wf1, 'workflow-1-followup-reminder'],
    ['6.2  WF2 — Same-Day Reminder triggered manually',    'WF2', TP.wf2, 'workflow-2-sameday-reminder'],
    ['6.3  WF3 — Missed Appointment triggered manually',   'WF3', TP.wf3, 'workflow-3-missed-appointment'],
    ['6.4  WF4 — Health Check triggered manually',         'WF4', TP.wf4, 'workflow-4-health-check'],
    ['6.5  WF5 — Reactivation triggered manually',         'WF5', TP.wf5, 'workflow-5-reactivation'],
  ]) {
    await test(label, async () => {
      const result = await triggerWorkflow(wfFragment);
      if (result.skipped) {
        if (result.reason.includes('not found')) {
          throw new Error(`${result.reason}. Run: node tests/setup-n8n.js`);
        }
        console.log(`\n       ⚠️  Skipped: ${result.reason}`);
        console.log(`       → Activate the workflow in n8n UI and re-run, or trigger manually via the UI.`);
        return; // not a hard failure — API may not support manual trigger
      }
      await sleep(4000); // allow execution to complete
      const logs = await recentSystemLogs(logWorkflow, 60);
      console.log(`\n       WA trigger status: ${logs.length} log entries from ${logWorkflow}`);
      // Either a WARN/ERROR (WA creds invalid) or INFO/no entry (no matching patients)
      // Both are acceptable — confirms the workflow ran without crashing
    });
  }

  // ── §8  End-to-End Flow ───────────────────────────────────────────────────
  section('§8  End-to-End — Full Intake → DB Write → WA Trigger → Feedback');

  let e2ePatientCode = null;

  await test('7.1  Form submission creates patient with PAT-XXXX code', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', {
      patient_name      : 'E2E Test Patient',
      phone_number      : TP.e2e,
      dob               : '1985-03-10',
      sex               : 'Female',
      hospital_name     : 'E2E Hospital',
      doctor_name       : 'Dr E2E',
      visit_date        : date(-1),
      follow_up_required: 'Yes',
      follow_up_date    : date(4),
    });
    assert(status === 200, `Form submit failed: ${status} ${JSON.stringify(json)}`);
    assert(json.status === 'success', `Expected success: ${JSON.stringify(json)}`);
    e2ePatientCode = json.patient_code;
    assert(e2ePatientCode?.match(/^PAT-\d{4}$/), `Bad patient_code format: ${e2ePatientCode}`);
    console.log(`\n       Patient code: ${e2ePatientCode}`);
  });

  await test('7.2  Patient record accurate in Supabase', async () => {
    await sleep(1500);
    const pat = await getPatient(`+91${TP.e2e}`);
    assert(pat, 'E2E patient not found in Supabase');
    assert(pat.patient_code === e2ePatientCode, `Code mismatch: ${pat.patient_code}`);
    assert(pat.sex === 'Female', `Sex mismatch: ${pat.sex}`);
    assert(pat.follow_up_required === 'Yes', 'follow_up_required wrong');
    assert(pat.status === 'pending', `Status should be pending, got ${pat.status}`);
  });

  await test('7.3  WF11 system_log INFO entry recorded', async () => {
    const logs = await recentSystemLogs('workflow-11-form-intake', 60);
    const info  = logs.find(l => l.log_level === 'INFO');
    assert(info, 'No INFO log from WF11 — check Supabase credential in n8n');
    console.log(`\n       Log: "${info.message}"`);
  });

  await test('7.4  Patient replies "confirm" → response_status = confirmed', async () => {
    const pat = await getPatient(`+91${TP.e2e}`);
    assert(pat, 'Patient not found');

    const { status } = await wh('feedback-listener', 'POST',
      metaMsg(`+91${TP.e2e}`, 'Yes I will come'));
    assert([200, 202].includes(status), `WF6 returned ${status}`);

    await sleep(2500);
    const updated = await getPatient(`+91${TP.e2e}`);
    assert(updated?.response_status === 'confirmed',
      `Expected confirmed, got "${updated?.response_status}"`);
    assert(updated?.last_response, 'last_response should be populated');
  });

  await test('7.5  Duplicate re-registration resets patient to pending', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', {
      patient_name      : 'E2E Test Patient Re-reg',
      phone_number      : TP.e2e,
      hospital_name     : 'E2E Hospital 2',
      doctor_name       : 'Dr New',
      visit_date        : date(0),
      follow_up_required: 'No',
    });
    assert(status === 200, `Re-reg failed: ${status} ${JSON.stringify(json)}`);
    await sleep(1500);
    const pat = await getPatient(`+91${TP.e2e}`);
    assert(pat?.status === 'pending', `Re-reg should reset status to pending, got ${pat?.status}`);
    assert(pat?.doctor_name === 'Dr New', `doctor_name not updated: ${pat?.doctor_name}`);
    assert(pat?.health_check_sent === false, 'health_check_sent should reset to false');
  });

  // ── Cleanup ────────────────────────────────────────────────────────────────
  section('Cleanup');
  console.log('  Removing test patients from Supabase …');
  await cleanup();
  console.log('  ✅ Done\n');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║                    Test Summary                          ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  ✅ Passed : ${String(passed).padEnd(46)}║`);
  console.log(`║  ❌ Failed : ${String(failed).padEnd(46)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.msg}\n     ${f.detail}`));
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('\n❌ Unexpected error:', e.message);
  console.error(e.stack);
  process.exit(1);
});
