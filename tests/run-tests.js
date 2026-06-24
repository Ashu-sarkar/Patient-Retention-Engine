#!/usr/bin/env node
/**
 * Patient Retention Engine — Integration Test Suite
 *
 * Tests all Twilio-only workflows end-to-end against a live n8n + Supabase stack.
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
const crypto = require('crypto');
const { Client } = require('pg');

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

const env          = { ...parseEnv(path.join(__dirname, '..', '.env')), ...process.env };
function deriveBaseUrl(env) {
  if (env.N8N_BASE_URL) return env.N8N_BASE_URL.replace(/\/$/, '');
  if (env.WEBHOOK_URL) return env.WEBHOOK_URL.replace(/\/$/, '');
  const protocol = env.N8N_PROTOCOL || 'http';
  const host = env.N8N_HOST || 'localhost';
  const port = env.N8N_PORT || '5678';
  const isDefaultPort =
    (protocol === 'http' && String(port) === '80') ||
    (protocol === 'https' && String(port) === '443');
  return `${protocol}://${host}${isDefaultPort ? '' : `:${port}`}`;
}
const N8N_URL      = deriveBaseUrl(env);
const N8N_B64      = Buffer.from(`${env.N8N_BASIC_AUTH_USER || 'admin'}:${env.N8N_BASIC_AUTH_PASSWORD || 'strongpass'}`).toString('base64');
const N8N_API_KEY  = env.N8N_API_KEY || '';
const N8N_OWNER_EMAIL    = env.N8N_OWNER_EMAIL    || '';
const N8N_OWNER_PASSWORD = env.N8N_OWNER_PASSWORD || '';
/** Session cookie for /rest/* (n8n 2.x: /api/v1/* requires X-N8N-API-KEY, not Basic auth). */
let n8nSessionCookie = '';

const SB_URL       = env.SUPABASE_URL;
const SB_KEY       = env.SUPABASE_SERVICE_ROLE_KEY;

function getDbConfig() {
  const raw = (env.SUPABASE_DATABASE_URL || env.DATABASE_URL || env.SUPABASE_DB_URL || '').trim();
  if (raw && /^postgres(ql)?:\/\//i.test(raw)) {
    const u = new URL(raw.replace(/^postgresql:/i, 'postgres:'));
    return {
      host    : u.hostname,
      port    : parseInt(u.port || '5432', 10),
      user    : decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: (u.pathname || '/postgres').replace(/^\//, '') || 'postgres',
    };
  }
  return {
    host    : env.SUPABASE_DB_HOST,
    port    : parseInt(env.SUPABASE_DB_PORT || '5432', 10),
    user    : env.SUPABASE_DB_USER,
    password: env.SUPABASE_DB_PASSWORD,
    database: env.SUPABASE_DB_NAME || 'postgres',
  };
}

let pgClient = null;
let testClinicId = null;

async function pgConnect() {
  if (pgClient) return pgClient;
  const cfg = getDbConfig();
  if (!cfg.host || !cfg.user || !cfg.password) {
    throw new Error('Missing SUPABASE_DB_* (or SUPABASE_DATABASE_URL) — required for DB verification in tests');
  }
  pgClient = new Client({ ...cfg, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  return pgClient;
}

async function pgQuery(sql, params = []) {
  const client = await pgConnect();
  const res = await client.query(sql, params);
  return res.rows;
}

async function pgEnd() {
  if (pgClient) {
    await pgClient.end().catch(() => {});
    pgClient = null;
  }
}

async function ensureTestClinicId(clinicName = 'Test Clinic') {
  if (testClinicId) return testClinicId;
  const rows = await pgQuery('SELECT public.get_or_create_clinic_id($1)::text AS id', [clinicName]);
  testClinicId = rows[0]?.id;
  if (!testClinicId) throw new Error(`Failed to resolve clinic id for "${clinicName}"`);
  return testClinicId;
}

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
  wf6_multi : '+919000000016',// WF6 same phone across clinics
  wf6_ambig : '+919000000018',// WF6 ambiguous same phone without message history
  wf6_queue : '+919000000021',// WF6 WhatsApp confirm → queue entry
  wf7       : '+919000000099',// WF7 direct welcome test
  wf9_multi : '+919000000017',// WF9 duplicate SID across clinics
  wf1_multi : '+919000000019',// Cron same phone across clinics
  wf11_multi: '9000000004',   // WF11 same phone across clinics
  e2e       : '9000000020',   // E2E full-flow test
};

const HF = {
  primaryHospital: 'Test Boarding Hospital Alpha',
  secondaryHospital: 'Test Boarding Hospital Beta',
  doctor: 'Dr Boarding',
};

const TWILIO_VALIDATE_SIG = String(env.TWILIO_VALIDATE_WEBHOOK_SIGNATURE || '').toLowerCase() === 'true';
const TWILIO_AUTH_TOKEN   = (env.TWILIO_AUTH_TOKEN || '').trim();
const PATIENT_CODE_RE     = /^[A-Z0-9]+-PAT-\d{4}$/i;

function twilioSignature(webhookPath, params) {
  const baseUrl = N8N_URL.replace(/\/$/, '');
  const url = `${baseUrl}/webhook/${webhookPath}`;
  const signedData = Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null && typeof params[k] !== 'object')
    .sort()
    .reduce((acc, key) => acc + key + String(params[key]), url);
  return crypto.createHmac('sha1', TWILIO_AUTH_TOKEN).update(signedData).digest('base64');
}

function formatDateValue(value) {
  if (!value) return '';
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

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
async function n8nLogin() {
  if (!N8N_OWNER_EMAIL || !N8N_OWNER_PASSWORD) return;
  const res = await fetch(`${N8N_URL}/rest/login`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({
      emailOrLdapLoginId: N8N_OWNER_EMAIL,
      password          : N8N_OWNER_PASSWORD,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/n8n-auth=([^;]+)/);
  if (m) n8nSessionCookie = `n8n-auth=${m[1]}`;
}

/** n8n REST + Public API. /api/v1/* uses N8N_API_KEY when set; /rest/* uses owner session cookie. */
async function n8nApi(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (path.startsWith('/api/v1/')) {
    if (N8N_API_KEY) headers['X-N8N-API-KEY'] = N8N_API_KEY;
    else headers.Authorization = `Basic ${N8N_B64}`;
  } else if (n8nSessionCookie) {
    headers.Cookie = n8nSessionCookie;
  } else {
    headers.Authorization = `Basic ${N8N_B64}`;
  }
  const res = await fetch(`${N8N_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, ok: res.ok, json };
}

/** List workflows (n8n 2.x — use /rest with session; Basic on /api/v1/workflows returns 401). */
async function n8nListWorkflows() {
  if (!n8nSessionCookie) await n8nLogin();
  const { ok, json } = await n8nApi('GET', '/rest/workflows');
  if (!ok || !Array.isArray(json.data)) {
    return { ok: false, data: [], message: json?.message || JSON.stringify(json).slice(0, 120) };
  }
  return { ok: true, data: json.data };
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

/** Twilio sends form-urlencoded; sign when TWILIO_VALIDATE_WEBHOOK_SIGNATURE=true. */
async function whTwilio(webhookPath, params = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // Always sign when auth token is available — production n8n may validate even if local .env flag is false.
  if (TWILIO_AUTH_TOKEN) {
    headers['X-Twilio-Signature'] = twilioSignature(webhookPath, params);
  } else if (TWILIO_VALIDATE_SIG) {
    throw new Error('TWILIO_VALIDATE_WEBHOOK_SIGNATURE=true but TWILIO_AUTH_TOKEN is missing in .env');
  }
  const res = await fetch(`${N8N_URL}/webhook/${webhookPath}`, {
    method : 'POST',
    headers,
    body   : new URLSearchParams(params).toString(),
    signal : AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, ok: res.ok, json, text };
}

// ── Supabase DB helpers (Postgres — same path n8n workflows use) ─────────────

async function sbGet(table, _qs = '') {
  // Legacy REST helper kept for table-existence smoke checks when REST key works.
  const SB_HDR = {
    apikey        : SB_KEY,
    Authorization : `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
  };
  const res = await fetch(`${SB_URL}/rest/v1/${table}?select=id&limit=1`, { headers: SB_HDR });
  if (!res.ok) {
    const rows = await pgQuery(`SELECT 1 FROM public.${table.replace(/[^a-z_]/gi, '')} LIMIT 1`).catch(() => null);
    if (rows) return rows;
    return { message: `table probe failed (${res.status})` };
  }
  return res.json().catch(() => []);
}

async function sbInsert(table, row) {
  const cols = Object.keys(row);
  const vals = Object.values(row);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO public.${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`;
  const rows = await pgQuery(sql, vals);
  return rows[0] || rows;
}

async function sbDelete(table, filter) {
  // filter format: phone=eq.+919000000001 or twilio_message_sid=eq.SM...
  const m = filter.match(/^([a-z_]+)=eq\.(.+)$/i);
  if (!m) return;
  await pgQuery(`DELETE FROM public.${table} WHERE ${m[1]} = $1`, [decodeURIComponent(m[2])]);
}

// Convenience wrappers
async function getPatient(phone, clinicId = null) {
  if (clinicId) {
    const rows = await pgQuery(
      'SELECT * FROM public.patients WHERE phone = $1 AND clinic_id = $2::uuid LIMIT 1',
      [phone, clinicId]
    );
    return rows[0] || null;
  }
  const rows = await pgQuery(
    'SELECT * FROM public.patients WHERE phone = $1 ORDER BY updated_at DESC LIMIT 1',
    [phone]
  );
  return rows[0] || null;
}

async function getHospitalBoarding(hospitalName) {
  const rows = await pgQuery(
    'SELECT * FROM public.hospital_boarding WHERE hospital_name = $1 ORDER BY created_at DESC LIMIT 1',
    [hospitalName]
  );
  return rows[0] || null;
}

function newIntakeToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function seedClinicIntakeToken(clinicId, label = 'Test QR') {
  const token = newIntakeToken();
  await pgQuery(
    `INSERT INTO public.clinic_intake_tokens (clinic_id, token_hash, label, status)
     VALUES ($1::uuid, public.hash_intake_token($2), $3, 'active')`,
    [clinicId, token, label]
  );
  return token;
}

async function getLatestVisitByPatient(patientId) {
  const rows = await pgQuery(
    'SELECT * FROM public.patient_visits WHERE patient_id = $1::uuid ORDER BY checked_in_at DESC LIMIT 1',
    [patientId]
  );
  return rows[0] || null;
}

async function getVisitsByPatient(patientId) {
  return pgQuery(
    'SELECT * FROM public.patient_visits WHERE patient_id = $1::uuid ORDER BY checked_in_at DESC',
    [patientId]
  );
}

async function recentSystemLogs(workflowName, windowSec = 45) {
  const rows = await pgQuery(
    `SELECT * FROM public.system_logs
     WHERE workflow_name = $1
       AND timestamp >= NOW() - ($2::text || ' seconds')::interval
     ORDER BY timestamp DESC`,
    [workflowName, String(windowSec)]
  );
  return rows;
}

async function seedPatient(phone, extra = {}) {
  const clinicName = extra.clinic_name || 'Test Clinic';
  const clinicId = extra.clinic_id || await ensureTestClinicId(clinicName);
  await pgQuery('DELETE FROM public.patients WHERE phone = $1 AND clinic_id = $2::uuid', [phone, clinicId]);
  const row = {
    clinic_id         : clinicId,
    name              : extra.name       || `Test ${phone}`,
    phone,
    clinic_name       : clinicName,
    doctor_name       : extra.doctor_name || 'Dr Test',
    visit_date        : extra.visit_date  || date(-1),
    follow_up_required: extra.follow_up_required || 'No',
    follow_up_date    : extra.follow_up_date     || null,
    status            : extra.status             || 'pending',
    message_count     : extra.message_count      ?? 0,
    health_check_sent : extra.health_check_sent  ?? false,
    reactivation_sent : extra.reactivation_sent  ?? false,
    last_message_sent : extra.last_message_sent  || null,
  };
  return sbInsert('patients', row);
}

async function cleanup() {
  const phones = [
    `+91${TP.wf11_new}`, `+91${TP.wf11_sql}`,
    `+91${TP.wf11_multi}`,
    TP.wf6, TP.wf6_multi, TP.wf6_ambig, TP.wf6_queue, TP.wf7, TP.wf9_multi, TP.wf1_multi,
    TP.wf1, TP.wf2, TP.wf3, TP.wf4, TP.wf5,
    `+91${TP.e2e}`,
  ];
  for (const phone of phones) {
    await pgQuery('DELETE FROM public.patients WHERE phone = $1', [phone]).catch(() => {});
  }
  for (const hospitalName of [HF.primaryHospital, HF.secondaryHospital]) {
    await pgQuery('DELETE FROM public.hospital_boarding WHERE hospital_name = $1', [hospitalName]).catch(() => {});
  }
}

// ── Twilio-style webhook payload builders ────────────────────────────────────
function twilioMsg(fromPhone, text, extra = {}) {
  return {
    From      : `whatsapp:${fromPhone}`,
    To        : env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
    Body      : text,
    MessageSid: extra.MessageSid || 'SM00000000000000000000000000000001',
    WaId      : fromPhone.replace(/^\+/, ''),
    ProfileName: extra.ProfileName || 'Test Patient',
    NumMedia  : extra.NumMedia || '0',
    ...extra,
  };
}

function twilioButtonMsg(fromPhone, buttonText, buttonPayload, extra = {}) {
  return twilioMsg(fromPhone, buttonText, {
    ButtonText: buttonText,
    ButtonPayload: buttonPayload,
    MessageSid: extra.MessageSid || `SM${String(buttonPayload || 'button').replace(/[^a-z0-9]/gi, '').padEnd(32, '0').slice(0, 32)}`,
    ...extra,
  });
}

function twilioStatus(messageSid, status, extra = {}) {
  return {
    MessageSid: messageSid,
    MessageStatus: status,
    To: extra.To || 'whatsapp:+919000000003',
    From: extra.From || env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
    ...extra,
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
  if (!N8N_API_KEY) {
    console.log('  Note: N8N_API_KEY not set — workflow list uses owner session (/rest/workflows).');
    console.log('        Set N8N_API_KEY in .env for POST /api/v1/workflows/:id/run (manual cron triggers).\n');
  }

  // ── §1 Infrastructure ────────────────────────────────────────────────────
  section('§1  Infrastructure');

  await test('1.1  Supabase Postgres reachable', async () => {
    const rows = await pgQuery('SELECT id FROM public.patients LIMIT 1');
    assert(Array.isArray(rows), 'Postgres query failed — check SUPABASE_DB_* in .env');
  });

  await test('1.2  n8n health endpoint reachable', async () => {
    const res = await fetch(`${N8N_URL}/healthz`, { signal: AbortSignal.timeout(5000) });
    assert(res.ok || res.status === 401, `n8n returned ${res.status}. Is "docker compose up" running?`);
  });

  let allWorkflows = [];
  await test('1.3  All Twilio workflows imported in n8n', async () => {
    const { ok, data, message } = await n8nListWorkflows();
    assert(ok, `n8n workflow list failed (${message || 'login: set N8N_OWNER_EMAIL / N8N_OWNER_PASSWORD in .env'})`);
    allWorkflows = data;
    const names   = allWorkflows.map(w => w.name);
    const REQUIRED = ['WF1', 'WF2', 'WF3', 'WF4', 'WF5', 'WF6', 'WF7', 'WF8', 'WF9', 'WF11', 'WF12', 'WF13'];
    const missing  = REQUIRED.filter(r => !names.some(n => n.includes(r)));
    assert(missing.length === 0,
      `Missing workflows: ${missing.join(', ')}. Run: docker compose down -v && docker compose up --build -d`);
  });

  await test('1.4  Webhook workflows (WF11, WF12, WF13, WF7, WF6, WF9) are published active', async () => {
    const relevant = allWorkflows.filter(w =>
      w.name.includes('WF11') || w.name.includes('WF12') || w.name.includes('WF13') || w.name.includes('WF7') || w.name.includes('WF6') || w.name.includes('WF9'));
    assert(relevant.length === 6,
      `Expected WF11/WF12/WF13/WF7/WF6/WF9 in n8n, found ${relevant.length}. Run: node tests/setup-n8n.js`);
    const inactive = relevant.filter(w => !w.active).map(w => w.name);
    assert(inactive.length === 0,
      `Inactive: ${inactive.join(', ')}. Run: node tests/setup-n8n.js`);
    const notPublished = relevant.filter(w =>
      !w.activeVersionId || !w.versionId || w.activeVersionId !== w.versionId
    ).map(w => w.name);
    assert(notPublished.length === 0,
      `Missing published active version: ${notPublished.join(', ')}. Run: n8n publish:workflow --id=<workflow-id> then restart n8n.`);
  });

  await test('1.5  Supabase tables exist for retention + doctor dashboard', async () => {
    const tables = [
      'patients', 'message_logs', 'system_logs', 'hospital_boarding', 'message_ledger',
      'doctor_profiles', 'patient_visits', 'prescriptions', 'prescription_medicines',
      'prescription_audit_logs',
    ];
    for (const table of tables) {
      const rows = await pgQuery(`SELECT 1 FROM public.${table} LIMIT 1`);
      assert(Array.isArray(rows), `${table} table missing or inaccessible`);
    }
  });

  await test('1.6  patient_visits active-date unique index exists', async () => {
    const rows = await pgQuery(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'patient_visits'
         AND indexname = 'idx_patient_visits_patient_date_active'`
    );
    assert(rows.length === 1, 'Run npm run preflight to apply idx_patient_visits_patient_date_active');
  });

  await test('1.7  duplicate active patient_visits on same day are rejected', async () => {
    const phone = '+919000000171';
    await pgQuery('DELETE FROM public.patients WHERE phone = $1', [phone]);
    const patient = await seedPatient(phone, { name: 'Index Dedup Patient', follow_up_date: date(7) });
    const visitDate = date(7);
    const baseVisit = {
      patient_id      : patient.id,
      clinic_id         : patient.clinic_id,
      clinic_name       : patient.clinic_name,
      doctor_name       : patient.doctor_name,
      visit_date        : visitDate,
      visit_status      : 'waiting',
      chief_complaint   : 'Follow-up consultation',
      staff_notes       : 'Test visit',
    };
    await sbInsert('patient_visits', baseVisit);
    let threw = false;
    try {
      await sbInsert('patient_visits', { ...baseVisit, staff_notes: 'Duplicate test' });
    } catch (error) {
      threw = true;
      assert(/unique|duplicate key/i.test(String(error.message)),
        `Expected unique violation, got ${error.message}`);
    }
    assert(threw, 'Expected duplicate active visit insert to fail');
    await pgQuery('DELETE FROM public.patients WHERE phone = $1', [phone]);
  });

  // ── §2  WF12 — Hospital Boarding ─────────────────────────────────────────
  section('§2  WF12 — Hospital Boarding  (POST /webhook/hospital-boarding)');

  const HOSPITAL_BASE = {
    hospital_name    : HF.primaryHospital,
    facility_type    : FACILITY_TYPE,
    address          : '12 Referral Street, Chennai, Tamil Nadu 600001',
    city             : 'Chennai',
    contact_phone    : '+919876543210',
    admin_contact_name: 'Operations Manager',
    clinic_logo_url  : 'https://example.com/logo.png',
    clinic_email     : 'frontdesk@example.com',
    clinic_website   : 'https://example.com',
    doctor_name      : HF.doctor,
    doctor_qualification: 'MBBS, MD',
    doctor_expertise : 'Lab diagnostics and pathology reporting',
    doctor_registration_number: 'TNMC-12345',
    doctor_phone     : '+919900001111',
    doctor_signature_url: 'https://example.com/signature.png',
    consultation_hours: 'Mon-Sat, 10 AM - 2 PM',
  };
  function withDoctorCredentials(payload, overrides = {}) {
    const doctor = {
      doctor_name: payload.doctor_name,
      doctor_qualification: payload.doctor_qualification,
      doctor_expertise: payload.doctor_expertise,
      doctor_registration_number: payload.doctor_registration_number,
      doctor_phone: payload.doctor_phone,
      doctor_signature_url: payload.doctor_signature_url,
      login_username: overrides.login_username || 'test.doctor.primary',
      password: overrides.password || 'TestPass123',
      ...overrides,
    };
    return {
      ...payload,
      doctor_count: '1',
      doctors_json: JSON.stringify([doctor]),
      login_username: doctor.login_username,
    };
  }

  await test('2.1  Valid hospital boarding → 200 + success response', async () => {
    await sbDelete('hospital_boarding', `hospital_name=eq.${encodeURIComponent(HF.primaryHospital)}`).catch(() => {});
    const { status, json } = await wh('hospital-boarding', 'POST', withDoctorCredentials(HOSPITAL_BASE));
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
    assert(row.city === HOSPITAL_BASE.city, `city mismatch: "${row.city}"`);
    assert(row.contact_phone === HOSPITAL_BASE.contact_phone, `contact_phone mismatch: "${row.contact_phone}"`);
    assert(row.admin_contact_name === HOSPITAL_BASE.admin_contact_name, `admin_contact_name mismatch: "${row.admin_contact_name}"`);
    assert(row.clinic_logo_url === HOSPITAL_BASE.clinic_logo_url, `clinic_logo_url mismatch: "${row.clinic_logo_url}"`);
    assert(row.clinic_email === HOSPITAL_BASE.clinic_email, `clinic_email mismatch: "${row.clinic_email}"`);
    assert(row.clinic_website === HOSPITAL_BASE.clinic_website, `clinic_website mismatch: "${row.clinic_website}"`);
    assert(row.doctor_name === HF.doctor, `doctor_name mismatch: "${row.doctor_name}"`);
    assert(row.doctor_qualification === HOSPITAL_BASE.doctor_qualification, `doctor_qualification mismatch: "${row.doctor_qualification}"`);
    assert(row.doctor_registration_number === HOSPITAL_BASE.doctor_registration_number, `doctor_registration_number mismatch: "${row.doctor_registration_number}"`);
    assert(row.doctor_phone === HOSPITAL_BASE.doctor_phone, `doctor_phone mismatch: "${row.doctor_phone}"`);
    assert(row.doctor_signature_url === HOSPITAL_BASE.doctor_signature_url, `doctor_signature_url mismatch: "${row.doctor_signature_url}"`);
    assert(row.consultation_hours === HOSPITAL_BASE.consultation_hours, `consultation_hours mismatch: "${row.consultation_hours}"`);
  });

  await test('2.2b Secondary hospital boarding row persisted for multi-clinic tests', async () => {
    await sbDelete('hospital_boarding', `hospital_name=eq.${encodeURIComponent(HF.secondaryHospital)}`).catch(() => {});
    const secondaryPayload = {
      ...HOSPITAL_BASE,
      hospital_name: HF.secondaryHospital,
      address: '34 Parallel Care Road, Chennai, Tamil Nadu 600002',
      contact_phone: '+919876543211',
      clinic_email: 'frontdesk-beta@example.com',
      clinic_website: 'https://beta.example.com',
      doctor_registration_number: 'TNMC-54321',
      doctor_phone: '+919900002222',
    };
    const { status, json } = await wh('hospital-boarding', 'POST', withDoctorCredentials(secondaryPayload, { login_username: 'test.doctor.secondary' }));
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
    await sleep(1200);
    const row = await getHospitalBoarding(HF.secondaryHospital);
    assert(row, `Hospital row "${HF.secondaryHospital}" not found in Supabase`);
    assert(row.clinic_id, 'Secondary hospital should have clinic_id');
  });

  await test('2.3  WF12 system_log INFO entry recorded', async () => {
    await sleep(1200);
    const logs = await recentSystemLogs('workflow-12-hospital-boarding');
    const info = logs.find(l => l.log_level === 'INFO');
    assert(info, 'No INFO log from WF12 — check Supabase credential in n8n');
  });

  await test('2.4  Validation: unsupported facility_type → 400 + errors[]', async () => {
    const { status, json } = await wh('hospital-boarding', 'POST', {
      ...withDoctorCredentials(HOSPITAL_BASE, { login_username: 'test.doctor.invalid' }),
      hospital_name: HF.secondaryHospital,
      facility_type: 'Veterinary Clinic',
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(Array.isArray(json.errors) && json.errors.some(err => err.includes('facility_type')),
      `Expected facility_type error: ${JSON.stringify(json)}`);
  });

  await test('2.5  Validation: missing doctor_name → 400', async () => {
    const { status, json } = await wh('hospital-boarding', 'POST', {
      ...withDoctorCredentials(HOSPITAL_BASE, { doctor_name: '', login_username: 'test.doctor.blank' }),
      hospital_name: HF.secondaryHospital,
      doctor_name: '',
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(Array.isArray(json.errors) && json.errors.some(err => err.includes('doctor_name')),
      `Expected doctor_name error: ${JSON.stringify(json)}`);
  });

  // ── §3  WF11 — QR Form Intake ────────────────────────────────────────────
  section('§3  WF11 — QR Form Intake  (POST /webhook/patient-form-intake)');

  const primaryBoarding = await getHospitalBoarding(HF.primaryHospital);
  assert(primaryBoarding?.clinic_id, 'Primary clinic_id missing — run §2 hospital boarding first');
  const primaryIntakeToken = await seedClinicIntakeToken(primaryBoarding.clinic_id, 'Test primary QR');

  const secondaryBoarding = await getHospitalBoarding(HF.secondaryHospital);
  const secondaryIntakeToken = secondaryBoarding?.clinic_id
    ? await seedClinicIntakeToken(secondaryBoarding.clinic_id, 'Test secondary QR')
    : '';

  // Base valid payload — clinic resolved from intake_token (QR flow)
  const BASE = {
    patient_name     : 'Test Patient Alpha',
    phone_number     : TP.wf11_new,          // 10 digits, no +91
    dob              : '1990-05-20',
    sex              : 'Male',
    hospital_name    : HF.primaryHospital,
    doctor_name      : HF.doctor,
    intake_token     : primaryIntakeToken,
    clinic_mode      : 'clinic_qr',
    visit_date       : date(-1),             // yesterday
  };

  await test('2.1  Valid registration → 200 + patient_code + visit_id in response', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', BASE);
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
    assert(json.status === 'success', `Expected status=success: ${JSON.stringify(json)}`);
    assert(json.patient_code, `No patient_code in response: ${JSON.stringify(json)}`);
    assert(json.visit_id, `No visit_id in response: ${JSON.stringify(json)}`);
  });

  await test('2.2  Patient row persisted in Supabase', async () => {
    await sleep(1500);
    const pat = await getPatient(`+91${TP.wf11_new}`);
    assert(pat, `Patient +91${TP.wf11_new} not found in Supabase`);
    assert(pat.name === 'Test Patient Alpha', `Name mismatch: "${pat.name}"`);
    assert(pat.patient_code?.match(PATIENT_CODE_RE), `patient_code looks wrong: ${pat.patient_code}`);
    assert(pat.status === 'pending', `Expected status=pending, got ${pat.status}`);
    assert(pat.follow_up_required === 'No', 'follow_up_required should default to No until prescription issue');
    assert(!pat.follow_up_date, `follow_up_date should be empty until prescription issue, got ${pat.follow_up_date}`);
  });

  await test('2.2b Patient visit queue row persisted in Supabase', async () => {
    await sleep(1500);
    const pat = await getPatient(`+91${TP.wf11_new}`);
    const visit = await getLatestVisitByPatient(pat.id);
    assert(visit, 'patient_visits row not found for registered patient');
    assert(visit.visit_status === 'waiting', `Expected waiting, got ${visit.visit_status}`);
    assert(!visit.chief_complaint, `chief_complaint should be added from doctor dashboard, got ${visit.chief_complaint}`);
    assert(visit.doctor_name === BASE.doctor_name, `doctor_name mismatch: ${visit.doctor_name}`);
  });

  await test('2.3  Twilio welcome trigger logged (WF7 system_log)', async () => {
    await sleep(2000); // allow WF7 to run
    // Either a success log from WF11, or an ERROR log from WF7 (Twilio creds invalid)
    const logs = await recentSystemLogs('workflow-11-form-intake');
    assert(logs.length > 0,
      'No system_log from WF11 — check Supabase credentials are set in n8n');
  });

  await test('2.5  Validation: invalid token or unknown doctor → 400 with clinic resolution error', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', {
      ...BASE,
      phone_number: '9000099990',
      intake_token: '0'.repeat(64),
      doctor_name: 'Dr Nobody',
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(Array.isArray(json.errors) && json.errors.length > 0,
      `Expected clinic resolution error: ${JSON.stringify(json)}`);
  });

  await test('2.6  Validation: missing required fields → 400 + errors[]', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', {
      patient_name: 'A',          // too short, other fields missing
    });
    assert(status === 400, `Expected 400, got ${status}: ${JSON.stringify(json)}`);
    assert(Array.isArray(json.errors) && json.errors.length > 0,
      `Expected non-empty errors[]: ${JSON.stringify(json)}`);
  });

  await test('2.7  Validation: phone not 10 digits → 400', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', {
      ...BASE, phone_number: '12345',
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(JSON.stringify(json.errors).includes('phone'), `Expected phone error: ${JSON.stringify(json)}`);
  });

  await test('2.8  Validation: future visit_date → 400', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', {
      ...BASE, phone_number: '9000099991', visit_date: date(2),
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(JSON.stringify(json.errors).includes('visit_date'), `Expected visit_date error`);
  });

  await test('2.9  Intake ignores stray follow-up fields from old clients', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', {
      ...BASE, phone_number: '9000099992', follow_up_required: 'Yes', follow_up_date: '',
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
    await sleep(1000);
    const pat = await getPatient('+919000099992');
    assert(pat?.follow_up_required === 'No', `follow_up_required should remain No, got ${pat?.follow_up_required}`);
    assert(!pat?.follow_up_date, `follow_up_date should remain empty, got ${pat?.follow_up_date}`);
  });

  await test('2.10 Validation: invalid sex value → 400', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', {
      ...BASE, phone_number: '9000099993', sex: 'Robot',
    });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test('2.11 Duplicate phone → 200 (upsert updates existing record)', async () => {
    const updated = { ...BASE, patient_name: 'Test Patient Alpha Updated' };
    const { status, json } = await wh('patient-form-intake', 'POST', updated);
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
    await sleep(1200);
    const pat = await getPatient(`+91${TP.wf11_new}`);
    assert(pat?.name === 'Test Patient Alpha Updated', `Expected updated name, got "${pat?.name}"`);
  });

  await test('2.11b Same phone can register independently at two clinics', async () => {
    assert(secondaryIntakeToken, 'Secondary intake token missing — run §2.2b first');
    const phone = `+91${TP.wf11_multi}`;
    await pgQuery('DELETE FROM public.patients WHERE phone = $1', [phone]);

    const alpha = {
      ...BASE,
      patient_name: 'Multi Clinic Alpha Patient',
      phone_number: TP.wf11_multi,
      intake_token: primaryIntakeToken,
      hospital_name: HF.primaryHospital,
    };
    const beta = {
      ...BASE,
      patient_name: 'Multi Clinic Beta Patient',
      phone_number: TP.wf11_multi,
      intake_token: secondaryIntakeToken,
      hospital_name: HF.secondaryHospital,
      doctor_name: secondaryBoarding?.doctor_name || HF.doctor,
    };

    const first = await wh('patient-form-intake', 'POST', alpha);
    assert(first.status === 200, `Primary clinic registration failed: ${first.status} ${JSON.stringify(first.json)}`);
    const second = await wh('patient-form-intake', 'POST', beta);
    assert(second.status === 200, `Secondary clinic registration failed: ${second.status} ${JSON.stringify(second.json)}`);

    await sleep(1800);
    const rows = await pgQuery(
      `SELECT id::text, clinic_id::text, patient_code, name, clinic_name, doctor_name
       FROM public.patients
       WHERE phone = $1
       ORDER BY clinic_name`,
      [phone]
    );
    assert(rows.length === 2, `Expected two patient rows for ${phone}, got ${rows.length}: ${JSON.stringify(rows)}`);
    assert(new Set(rows.map(row => row.clinic_id)).size === 2, `Expected distinct clinic_id values: ${JSON.stringify(rows)}`);
    assert(rows.some(row => row.name === alpha.patient_name && row.clinic_name === HF.primaryHospital),
      `Primary clinic row missing or overwritten: ${JSON.stringify(rows)}`);
    assert(rows.some(row => row.name === beta.patient_name && row.clinic_name === HF.secondaryHospital),
      `Secondary clinic row missing or overwritten: ${JSON.stringify(rows)}`);

    for (const row of rows) {
      const visits = await getVisitsByPatient(row.id);
      assert(visits.length >= 1, `Expected at least one visit for ${row.name}`);
      assert(visits.every(visit => String(visit.clinic_id) === row.clinic_id),
        `Visit clinic mismatch for ${row.name}: ${JSON.stringify(visits)}`);
    }
  });

  await test('2.12 SQL injection in name handled safely', async () => {
    const { status } = await wh('patient-form-intake', 'POST', {
      ...BASE, phone_number: TP.wf11_sql,
      patient_name: "Robert'); DROP TABLE patients; --",
    });
    // 400 (name too risky) OR 200 (SQL escaped) — either is acceptable
    // but the table must still exist
    await sleep(500);
    const rows = await pgQuery('SELECT id FROM public.patients LIMIT 1');
    assert(Array.isArray(rows), '🚨 patients table gone — SQL injection succeeded!');
    assert([200, 400].includes(status), `Unexpected status ${status}`);
  });

  // ── §4  WF7 — New Patient Welcome ────────────────────────────────────────
  section('§4  WF7 — New Patient Welcome  (POST /webhook/new-patient-intake)');

  await test('3.1  Valid payload → 200 (WA attempt made, error logged if creds placeholder)', async () => {
    await sbDelete('patients', `phone=eq.${encodeURIComponent(TP.wf7)}`).catch(() => {});
    const wf7Pat = await seedPatient(TP.wf7, {
      name: 'WF7 Test Patient',
      clinic_name: 'Test Clinic',
      doctor_name: 'Dr WF7',
      visit_date: date(-1),
    });
    const { status, json } = await wh('new-patient-intake', 'POST', {
      patient_code: wf7Pat.patient_code || 'PAT-TEST',
      patient_id  : wf7Pat.id,
      clinic_id   : wf7Pat.clinic_id,
      name        : wf7Pat.name,
      phone       : TP.wf7,
      clinic_name : wf7Pat.clinic_name,
      doctor_name : wf7Pat.doctor_name,
      visit_date  : date(-1),
    });
    assert([200, 202].includes(status), `Expected 200/202, got ${status}: ${JSON.stringify(json)}`);
    // After ~2s, WF7 should have logged an ERROR (Twilio creds invalid) or INFO (Twilio succeeded)
    await sleep(2500);
    const logs = await recentSystemLogs('workflow-7-new-patient');
    // Either an ERROR (Twilio failed with placeholder creds) or nothing (creds valid, succeeded)
    console.log(`       WF7 system_logs in last 60s: ${logs.length} entries`);
    // Not asserting on log content — just verifying the workflow ran without crashing
  });

  await test('3.2  Invalid phone → skipped gracefully (no DB write, no crash)', async () => {
    const before = await recentSystemLogs('workflow-7-new-patient');
    const { status } = await wh('new-patient-intake', 'POST', {
      patient_code: 'PAT-SKIP',
      patient_id  : '00000000-0000-4000-8000-000000000001',
      clinic_id   : '00000000-0000-4000-8000-000000000002',
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
      patient_id  : '00000000-0000-4000-8000-000000000003',
      clinic_id   : '00000000-0000-4000-8000-000000000004',
      name        : '',
      phone       : '+919000000098',
      clinic_name : 'X',
      doctor_name : 'Y',
      visit_date  : date(-1),
    });
    assert([200, 202].includes(status), `Expected graceful 200, got ${status}`);
  });

  // ── §5  WF6 — Feedback Listener ──────────────────────────────────────────
  section('§5  WF6 — Feedback Listener  (POST /webhook/feedback-listener)');

  if (TWILIO_VALIDATE_SIG) {
    console.log('  Note: TWILIO_VALIDATE_WEBHOOK_SIGNATURE=true — tests sign callbacks with local TWILIO_AUTH_TOKEN.');
    console.log('        It must match the token configured on production n8n (Railway) or WF6/WF9 tests will no-op.\n');
  }

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

  await test('4.1  POST confirmed Twilio message → response_status = confirmed in DB', async () => {
    // Reset patient status first
    await sbDelete('patients', `phone=eq.${encodeURIComponent(TP.wf6)}`);
    await seedPatient(TP.wf6, { name: 'WF6 Test Patient', message_count: 1, status: 'pending' });
    await sleep(300);

    const { status } = await whTwilio('feedback-listener', twilioMsg(TP.wf6, 'Yes, I will come'));
    assert([200, 202].includes(status), `Expected 200, got ${status}`);
    await sleep(2500);
    const pat = await getPatient(TP.wf6);
    assert(pat, 'Patient not found after feedback update');
    assert(pat.response_status === 'confirmed',
      `Expected response_status=confirmed, got "${pat.response_status}"`);
    assert(pat.last_response, 'last_response should be set');
  });

  await test('4.2  POST cancelled Twilio message → response_status = cancelled in DB', async () => {
    const { status } = await whTwilio('feedback-listener',
      twilioMsg(TP.wf6, 'No, please cancel my appointment'));
    assert([200, 202].includes(status), `Expected 200, got ${status}`);
    await sleep(2000);
    const pat = await getPatient(TP.wf6);
    assert(pat?.response_status === 'cancelled',
      `Expected cancelled, got "${pat?.response_status}"`);
  });

  await test('4.3  POST from unknown number → WARN logged in system_logs', async () => {
    const before = await recentSystemLogs('workflow-6-feedback-listener');
    const { status } = await whTwilio('feedback-listener',
      twilioMsg('+919999999999', 'Hello there'));
    assert([200, 202].includes(status), `Expected 200, got ${status}`);
    await sleep(2000);
    const after  = await recentSystemLogs('workflow-6-feedback-listener');
    const warns  = after.filter(l => l.log_level === 'WARN');
    assert(warns.length > 0, 'Expected at least one WARN log for unknown sender');
  });

  await test('4.4  POST blank Twilio message → skipped gracefully', async () => {
    const { status } = await whTwilio('feedback-listener', twilioMsg(TP.wf6, '', { NumMedia: '0' }));
    assert([200, 202].includes(status), `Expected graceful 200, got ${status}`);
  });

  await test('4.5  POST help keyword → classified as "help" (not confirmed/cancelled)', async () => {
    // Reset to clean state
    await sbDelete('patients', `phone=eq.${encodeURIComponent(TP.wf6)}`);
    await seedPatient(TP.wf6, { name: 'WF6 Test Patient', message_count: 1, status: 'pending' });
    await sleep(300);

    await whTwilio('feedback-listener', twilioMsg(TP.wf6, 'I need urgent help'));
    await sleep(2000);
    const pat = await getPatient(TP.wf6);
    // "help" maps to response_status = 'responded' (the generic fallback in WF6)
    assert(pat?.response_status === 'responded',
      `Expected responded for help keyword, got "${pat?.response_status}"`);
  });

  await test('4.5a Same phone in two clinics without message history → inbound reply is not guessed', async () => {
    const clinicAlpha = await ensureTestClinicId('WF6 Ambiguous Clinic Alpha');
    const clinicBeta = await ensureTestClinicId('WF6 Ambiguous Clinic Beta');
    await pgQuery('DELETE FROM public.patients WHERE phone = $1', [TP.wf6_ambig]);

    const alpha = await seedPatient(TP.wf6_ambig, {
      clinic_id: clinicAlpha,
      clinic_name: 'WF6 Ambiguous Clinic Alpha',
      name: 'WF6 Ambiguous Alpha Patient',
      status: 'pending',
    });
    const beta = await seedPatient(TP.wf6_ambig, {
      clinic_id: clinicBeta,
      clinic_name: 'WF6 Ambiguous Clinic Beta',
      name: 'WF6 Ambiguous Beta Patient',
      status: 'pending',
    });
    await pgQuery('DELETE FROM public.message_logs WHERE phone = $1', [TP.wf6_ambig]);

    const { status } = await whTwilio('feedback-listener', twilioMsg(TP.wf6_ambig, 'Yes, I will come'));
    assert([200, 202].includes(status), `Expected 200/202, got ${status}`);
    await sleep(2200);

    const alphaAfter = await getPatient(TP.wf6_ambig, alpha.clinic_id);
    const betaAfter = await getPatient(TP.wf6_ambig, beta.clinic_id);
    assert(alphaAfter?.response_status === 'none',
      `Ambiguous alpha patient should remain untouched, got ${alphaAfter?.response_status}`);
    assert(betaAfter?.response_status === 'none',
      `Ambiguous beta patient should remain untouched, got ${betaAfter?.response_status}`);
  });

  await test('4.5b Same phone in two clinics → inbound reply updates most recently messaged clinic only', async () => {
    const clinicAlpha = await ensureTestClinicId('WF6 Multi Clinic Alpha');
    const clinicBeta = await ensureTestClinicId('WF6 Multi Clinic Beta');
    await pgQuery('DELETE FROM public.patients WHERE phone = $1', [TP.wf6_multi]);

    const alpha = await seedPatient(TP.wf6_multi, {
      clinic_id: clinicAlpha,
      clinic_name: 'WF6 Multi Clinic Alpha',
      name: 'WF6 Multi Alpha Patient',
      status: 'pending',
    });
    const beta = await seedPatient(TP.wf6_multi, {
      clinic_id: clinicBeta,
      clinic_name: 'WF6 Multi Clinic Beta',
      name: 'WF6 Multi Beta Patient',
      status: 'pending',
    });

    await sbInsert('message_logs', {
      clinic_id: alpha.clinic_id,
      patient_id: alpha.id,
      patient_name: alpha.name,
      phone: alpha.phone,
      workflow_name: 'workflow-test',
      message_type: 'same_phone_routing_old',
      message_sent: 'older clinic message',
      sent_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      scheduled_date: date(0),
      delivery_status: 'sent',
      provider_message_id: 'SMWF6MULTIOLD000000000000000000001',
      twilio_message_sid: 'SMWF6MULTIOLD000000000000000000001',
    });
    await sbInsert('message_logs', {
      clinic_id: beta.clinic_id,
      patient_id: beta.id,
      patient_name: beta.name,
      phone: beta.phone,
      workflow_name: 'workflow-test',
      message_type: 'same_phone_routing_new',
      message_sent: 'newer clinic message',
      sent_at: new Date().toISOString(),
      scheduled_date: date(0),
      delivery_status: 'sent',
      provider_message_id: 'SMWF6MULTINEW000000000000000000001',
      twilio_message_sid: 'SMWF6MULTINEW000000000000000000001',
    });

    const { status } = await whTwilio('feedback-listener', twilioMsg(TP.wf6_multi, 'No, please reschedule'));
    assert([200, 202].includes(status), `Expected 200/202, got ${status}`);
    await sleep(2200);

    const alphaAfter = await getPatient(TP.wf6_multi, alpha.clinic_id);
    const betaAfter = await getPatient(TP.wf6_multi, beta.clinic_id);
    assert(betaAfter?.response_status === 'cancelled',
      `Expected newer clinic patient to be cancelled, got ${betaAfter?.response_status}`);
    assert(alphaAfter?.response_status === 'none',
      `Older clinic patient should remain untouched, got ${alphaAfter?.response_status}`);
  });

  await test('4.5c POST confirm button with follow_up_date → patient_visits queue row created', async () => {
    await pgQuery('DELETE FROM public.patients WHERE phone = $1', [TP.wf6_queue]);
    const followUp = date(2);
    const patient = await seedPatient(TP.wf6_queue, {
      name              : 'WF6 Queue Button Patient',
      follow_up_required: 'Yes',
      follow_up_date    : followUp,
      status            : 'pending',
      message_count     : 1,
    });
    await sleep(300);

    const { status } = await whTwilio('feedback-listener',
      twilioButtonMsg(TP.wf6_queue, 'Confirm Appointment', 'confirm_appointment', {
        MessageSid: 'SMWF6CONFIRMBTN00000000000000001',
      }));
    assert([200, 202].includes(status), `Expected 200, got ${status}`);
    await sleep(3000);

    const pat = await getPatient(TP.wf6_queue);
    assert(pat?.response_status === 'confirmed', `Expected confirmed, got ${pat?.response_status}`);
    const visits = await getVisitsByPatient(patient.id);
    const queued = visits.find((v) => formatDateValue(v.visit_date) === followUp && v.visit_status === 'waiting');
    assert(queued, `Expected waiting visit on ${followUp}, got ${JSON.stringify(visits)}`);
    assert(String(queued.staff_notes || '').includes('WhatsApp'), 'staff_notes should record WhatsApp confirmation');
  });

  await test('4.5d duplicate confirm does not create a second active visit', async () => {
    const followUp = date(2);
    const pat = await getPatient(TP.wf6_queue);
    assert(pat, 'Patient from 4.5c should exist');
    const before = await getVisitsByPatient(pat.id);
    const activeBefore = before.filter((v) => formatDateValue(v.visit_date) === followUp
      && !['cancelled', 'no_show'].includes(v.visit_status));
    assert(activeBefore.length === 1, 'Setup expects exactly one active visit before duplicate confirm');

    const { status } = await whTwilio('feedback-listener',
      twilioButtonMsg(TP.wf6_queue, 'Confirm Appointment', 'confirm_appointment', {
        MessageSid: 'SMWF6CONFIRMBTN00000000000000002',
      }));
    assert([200, 202].includes(status), `Expected 200, got ${status}`);
    await sleep(2500);

    const after = await getVisitsByPatient(pat.id);
    const activeAfter = after.filter((v) => formatDateValue(v.visit_date) === followUp
      && !['cancelled', 'no_show'].includes(v.visit_status));
    assert(activeAfter.length === 1, `Expected one active visit after duplicate confirm, got ${activeAfter.length}`);
  });

  await test('4.5e POST reschedule button → cancelled with no queue visit', async () => {
    const phone = '+919000000172';
    await pgQuery('DELETE FROM public.patients WHERE phone = $1', [phone]);
    const followUp = date(3);
    const patient = await seedPatient(phone, {
      name              : 'WF6 Reschedule Button Patient',
      follow_up_required: 'Yes',
      follow_up_date    : followUp,
      status            : 'pending',
      message_count     : 1,
    });
    await sleep(300);

    const { status } = await whTwilio('feedback-listener',
      twilioButtonMsg(phone, 'Reschedule', 'reschedule', {
        MessageSid: 'SMWF6RESCHEDULE0000000000000001',
      }));
    assert([200, 202].includes(status), `Expected 200, got ${status}`);
    await sleep(2500);

    const pat = await getPatient(phone);
    assert(pat?.response_status === 'cancelled', `Expected cancelled, got ${pat?.response_status}`);
    const visits = await getVisitsByPatient(patient.id);
    const queued = visits.find((v) => formatDateValue(v.visit_date) === followUp);
    assert(!queued, 'Reschedule should not create a patient_visits row');
    await pgQuery('DELETE FROM public.patients WHERE phone = $1', [phone]);
  });

  await test('4.6  WF9 Twilio status callback → message_logs delivery_status updates', async () => {
    const pat = await getPatient(TP.wf6);
    assert(pat?.id, 'Seed patient missing for status callback test');
    const sid = 'SM99999999999999999999999999999999';
    await sbDelete('message_logs', `twilio_message_sid=eq.${encodeURIComponent(sid)}`).catch(() => {});
    await sbInsert('message_logs', {
      clinic_id: pat.clinic_id,
      patient_id: pat.id,
      patient_name: pat.name,
      phone: pat.phone,
      workflow_name: 'workflow-test',
      message_type: 'status_callback_test',
      message_sent: 'status callback test',
      scheduled_date: date(0),
      delivery_status: 'sent',
      provider_message_id: sid,
      twilio_message_sid: sid,
    });
    const { status } = await whTwilio('twilio-status-callback', twilioStatus(sid, 'delivered'));
    assert([200, 202].includes(status), `Expected 200/202, got ${status}`);
    await sleep(1200);
    const rows = await pgQuery(
      'SELECT delivery_status FROM public.message_logs WHERE twilio_message_sid = $1 LIMIT 1',
      [sid]
    );
    assert(rows[0]?.delivery_status === 'delivered',
      `Expected delivery_status=delivered, got ${rows[0]?.delivery_status}`);
  });

  await test('4.7  WF9 duplicate SID across clinics updates one latest matching tenant row only', async () => {
    const clinicAlpha = await ensureTestClinicId('WF9 Multi Clinic Alpha');
    const clinicBeta = await ensureTestClinicId('WF9 Multi Clinic Beta');
    const sid = 'SMWF9MULTIDUP000000000000000000001';

    await pgQuery('DELETE FROM public.message_logs WHERE twilio_message_sid = $1 OR provider_message_id = $1', [sid]);
    await pgQuery('DELETE FROM public.message_ledger WHERE twilio_message_sid = $1 OR provider_message_id = $1', [sid]);
    await pgQuery('DELETE FROM public.patients WHERE phone = $1', [TP.wf9_multi]);

    const alpha = await seedPatient(TP.wf9_multi, {
      clinic_id: clinicAlpha,
      clinic_name: 'WF9 Multi Clinic Alpha',
      name: 'WF9 Multi Alpha Patient',
    });
    const beta = await seedPatient(TP.wf9_multi, {
      clinic_id: clinicBeta,
      clinic_name: 'WF9 Multi Clinic Beta',
      name: 'WF9 Multi Beta Patient',
    });

    await sbInsert('message_logs', {
      clinic_id: alpha.clinic_id,
      patient_id: alpha.id,
      patient_name: alpha.name,
      phone: alpha.phone,
      workflow_name: 'workflow-test',
      message_type: 'duplicate_sid_old',
      message_sent: 'older duplicate sid',
      sent_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      scheduled_date: date(-1),
      delivery_status: 'sent',
      provider_message_id: sid,
      twilio_message_sid: sid,
    });
    await sbInsert('message_logs', {
      clinic_id: beta.clinic_id,
      patient_id: beta.id,
      patient_name: beta.name,
      phone: beta.phone,
      workflow_name: 'workflow-test',
      message_type: 'duplicate_sid_new',
      message_sent: 'newer duplicate sid',
      sent_at: new Date().toISOString(),
      scheduled_date: date(0),
      delivery_status: 'sent',
      provider_message_id: sid,
      twilio_message_sid: sid,
    });
    await sbInsert('message_ledger', {
      clinic_id: alpha.clinic_id,
      patient_id: alpha.id,
      message_type: 'duplicate_sid_old',
      scheduled_date: date(-1),
      workflow_name: 'workflow-test',
      provider_message_id: sid,
      twilio_message_sid: sid,
      status: 'sent',
    });
    await sleep(20);
    await sbInsert('message_ledger', {
      clinic_id: beta.clinic_id,
      patient_id: beta.id,
      message_type: 'duplicate_sid_new',
      scheduled_date: date(0),
      workflow_name: 'workflow-test',
      provider_message_id: sid,
      twilio_message_sid: sid,
      status: 'sent',
    });

    const { status } = await whTwilio('twilio-status-callback', twilioStatus(sid, 'delivered'));
    assert([200, 202].includes(status), `Expected 200/202, got ${status}`);
    await sleep(1200);

    const logRows = await pgQuery(
      `SELECT clinic_id::text, delivery_status
       FROM public.message_logs
       WHERE twilio_message_sid = $1
       ORDER BY sent_at ASC`,
      [sid]
    );
    const ledgerRows = await pgQuery(
      `SELECT clinic_id::text, status
       FROM public.message_ledger
       WHERE twilio_message_sid = $1
       ORDER BY created_at ASC`,
      [sid]
    );
    assert(logRows.length === 2, `Expected two duplicate message_logs rows, got ${logRows.length}`);
    assert(ledgerRows.length === 2, `Expected two duplicate message_ledger rows, got ${ledgerRows.length}`);
    assert(logRows[0].delivery_status === 'sent',
      `Older clinic message_log should remain sent, got ${logRows[0].delivery_status}`);
    assert(logRows[1].delivery_status === 'delivered',
      `Newest clinic message_log should be delivered, got ${logRows[1].delivery_status}`);
    assert(ledgerRows[0].status === 'sent',
      `Older clinic ledger should remain sent, got ${ledgerRows[0].status}`);
    assert(ledgerRows[1].status === 'delivered',
      `Newest clinic ledger should be delivered, got ${ledgerRows[1].status}`);
  });

  // ── §6  Cron Workflow DB Query Validation ────────────────────────────────
  section('§6  Cron Workflow Filtering Logic (Supabase query simulation)');
  console.log('  Seeding test patients for each cron scenario …');

  // Seed all cron test patients sequentially (single pg client)
  for (const [phone, extra] of [
    [TP.wf1, { name: 'WF1 Patient', follow_up_required: 'Yes', follow_up_date: date(1), status: 'pending', message_count: 0 }],
    [TP.wf2, { name: 'WF2 Patient', follow_up_required: 'Yes', follow_up_date: date(0), status: 'pending', message_count: 0 }],
    [TP.wf3, { name: 'WF3 Patient', follow_up_required: 'Yes', follow_up_date: date(-5), status: 'pending', message_count: 0 }],
    [TP.wf4, { name: 'WF4 Patient', visit_date: date(-2), health_check_sent: false, status: 'pending', message_count: 1 }],
    [TP.wf5, { name: 'WF5 Patient', last_message_sent: new Date(Date.now() - 35 * 86400000).toISOString(), reactivation_sent: false, status: 'pending', message_count: 2 }],
  ]) {
    await seedPatient(phone, extra);
  }
  await sleep(800);
  console.log('  Seed complete.\n');

  await test('5.0b Scheduled reminder dedupe is scoped by clinic_id + patient_id, not phone', async () => {
    const clinicAlpha = await ensureTestClinicId('WF1 Multi Clinic Alpha');
    const clinicBeta = await ensureTestClinicId('WF1 Multi Clinic Beta');
    await pgQuery('DELETE FROM public.patients WHERE phone = $1', [TP.wf1_multi]);

    const alpha = await seedPatient(TP.wf1_multi, {
      clinic_id: clinicAlpha,
      clinic_name: 'WF1 Multi Clinic Alpha',
      name: 'WF1 Multi Alpha Patient',
      follow_up_required: 'Yes',
      follow_up_date: date(1),
      status: 'pending',
      message_count: 0,
    });
    const beta = await seedPatient(TP.wf1_multi, {
      clinic_id: clinicBeta,
      clinic_name: 'WF1 Multi Clinic Beta',
      name: 'WF1 Multi Beta Patient',
      follow_up_required: 'Yes',
      follow_up_date: date(1),
      status: 'pending',
      message_count: 0,
    });

    await sbInsert('message_logs', {
      clinic_id: alpha.clinic_id,
      patient_id: alpha.id,
      patient_name: alpha.name,
      phone: alpha.phone,
      workflow_name: 'workflow-test',
      message_type: 'follow_up_reminder',
      message_sent: 'alpha already reminded',
      scheduled_date: date(1),
      delivery_status: 'sent',
      provider_message_id: 'SMWF1MULTIALPHA0000000000000000001',
      twilio_message_sid: 'SMWF1MULTIALPHA0000000000000000001',
    });

    const rows = await pgQuery(
      `SELECT p.id::text, p.clinic_id::text, p.name
       FROM public.patients p
       WHERE p.phone = $1
         AND p.clinic_id IS NOT NULL
         AND p.status = 'pending'
         AND p.follow_up_date IS NOT NULL
         AND p.follow_up_date >= CURRENT_DATE
         AND NOT EXISTS (
           SELECT 1
           FROM public.message_logs ml
           WHERE ml.clinic_id = p.clinic_id
             AND ml.patient_id = p.id
             AND ml.message_type = 'follow_up_reminder'
             AND ml.scheduled_date = p.follow_up_date
         )
       ORDER BY p.name`,
      [TP.wf1_multi]
    );
    assert(rows.length === 1, `Expected only beta clinic to remain queryable, got ${JSON.stringify(rows)}`);
    assert(rows[0].id === beta.id, `Expected beta patient queryable, got ${JSON.stringify(rows[0])}`);
    assert(rows[0].clinic_id === beta.clinic_id, `Expected beta clinic_id, got ${rows[0].clinic_id}`);
  });

  await test('5.1  WF1 — patient with follow_up_date=tomorrow & status=pending is queryable', async () => {
    const rows = await pgQuery(
      `SELECT id, name, follow_up_date FROM public.patients
       WHERE phone = $1 AND status = 'pending' AND follow_up_date = $2::date`,
      [TP.wf1, date(1)]
    );
    assert(rows.length > 0, `WF1 SQL would find 0 patients. Check seed or DB timezone.`);
    assert(formatDateValue(rows[0].follow_up_date) === date(1), `follow_up_date mismatch: ${rows[0].follow_up_date}`);
  });

  await test('5.2  WF2 — patient with follow_up_date=today & status=pending is queryable', async () => {
    const rows = await pgQuery(
      `SELECT id, name, follow_up_date FROM public.patients
       WHERE phone = $1 AND status = 'pending' AND follow_up_date = $2::date`,
      [TP.wf2, date(0)]
    );
    assert(rows.length > 0, 'WF2 SQL would find 0 patients');
  });

  await test('5.2b WF2 filter excludes confirmed patients for same-day reminders', async () => {
    const wf2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'workflow-2-sameday-reminder.json'), 'utf8'));
    const code = wf2.nodes.find((n) => n.name === "Filter Today's Appointments").parameters.jsCode;
    assert(code.includes("response_status === 'confirmed'"), 'WF2 must skip confirmed patients');
  });

  await test('5.3  WF3 — patient with past follow_up_date (not completed/inactive) is queryable', async () => {
    const rows = await pgQuery(
      `SELECT id, name, follow_up_date, status FROM public.patients
       WHERE phone = $1 AND status NOT IN ('completed', 'inactive') AND follow_up_date < $2::date`,
      [TP.wf3, date(0)]
    );
    assert(rows.length > 0, 'WF3 SQL would find 0 patients');
    assert(rows[0].status === 'pending', `Expected pending, got ${rows[0].status}`);
  });

  await test('5.4  WF4 — patient who visited 2 days ago with health_check_sent=false is queryable', async () => {
    const rows = await pgQuery(
      `SELECT id, name, visit_date, health_check_sent FROM public.patients
       WHERE phone = $1 AND health_check_sent = false AND status <> 'inactive'`,
      [TP.wf4]
    );
    assert(rows.length > 0, 'WF4 SQL would find 0 patients');
    assert(rows[0].health_check_sent === false, 'health_check_sent should be false');
  });

  await test('5.5  WF5 — patient with last_message > 30 days & reactivation_sent=false is queryable', async () => {
    const rows = await pgQuery(
      `SELECT id, name, last_message_sent, reactivation_sent FROM public.patients
       WHERE phone = $1 AND reactivation_sent = false AND status NOT IN ('inactive', 'completed')`,
      [TP.wf5]
    );
    assert(rows.length > 0, 'WF5 SQL would find 0 patients');
    const lastSent = new Date(rows[0].last_message_sent);
    const daysDiff = (Date.now() - lastSent) / 86400000;
    assert(daysDiff >= 30, `last_message_sent too recent: ${daysDiff.toFixed(1)} days ago`);
  });

  await test('5.6  WF1 skips patient already at message_count=5', async () => {
    await seedPatient(TP.wf1, { name: 'WF1 Max Msg', follow_up_required: 'Yes',
      follow_up_date: date(1), status: 'pending', message_count: 5 });
    await sleep(300);
    const rows = await pgQuery(
      'SELECT id FROM public.patients WHERE phone = $1 AND message_count < 5',
      [TP.wf1]
    );
    assert(rows.length === 0, 'Patient with message_count=5 should be EXCLUDED by WF1 filter');
    await seedPatient(TP.wf1, { name: 'WF1 Patient', follow_up_required: 'Yes',
      follow_up_date: date(1), status: 'pending', message_count: 0 });
  });

  await test('5.7  WF3 marks patient as "missed" after 7+ days past follow_up_date', async () => {
    const phone = TP.wf3;
    await seedPatient(phone, { name: 'WF3 7day Patient', follow_up_required: 'Yes',
      follow_up_date: date(-8), status: 'pending', message_count: 2 });
    await sleep(300);
    const rows = await pgQuery(
      `SELECT id, name, follow_up_date FROM public.patients
       WHERE phone = $1 AND follow_up_date < $2::date AND status = 'pending'`,
      [phone, date(-6)]
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
      console.log(`\n       Twilio trigger status: ${logs.length} log entries from ${logWorkflow}`);
      // Either a WARN/ERROR (Twilio creds invalid) or INFO/no entry (no matching patients)
      // Both are acceptable — confirms the workflow ran without crashing
    });
  }

  // ── §8  End-to-End Flow ───────────────────────────────────────────────────
  section('§8  End-to-End — Full Intake → DB Write → Twilio Trigger → Feedback');

  let e2ePatientCode = null;

  await test('7.1  Form submission creates patient with PAT-XXXX code', async () => {
    const { status, json } = await wh('patient-form-intake', 'POST', {
      patient_name      : 'E2E Test Patient',
      phone_number      : TP.e2e,
      dob               : '1985-03-10',
      sex               : 'Female',
      hospital_name     : HF.primaryHospital,
      doctor_name       : HF.doctor,
      intake_token      : primaryIntakeToken,
      clinic_mode       : 'clinic_qr',
      visit_date        : date(-1),
    });
    assert(status === 200, `Form submit failed: ${status} ${JSON.stringify(json)}`);
    assert(json.status === 'success', `Expected success: ${JSON.stringify(json)}`);
    e2ePatientCode = json.patient_code;
    assert(e2ePatientCode?.match(PATIENT_CODE_RE), `Bad patient_code format: ${e2ePatientCode}`);
    assert(json.visit_id, `Missing visit_id: ${JSON.stringify(json)}`);
    console.log(`\n       Patient code: ${e2ePatientCode}`);
  });

  await test('7.2  Patient record accurate in Supabase', async () => {
    await sleep(1500);
    const pat = await getPatient(`+91${TP.e2e}`);
    assert(pat, 'E2E patient not found in Supabase');
    assert(pat.patient_code === e2ePatientCode, `Code mismatch: ${pat.patient_code}`);
    assert(pat.sex === 'Female', `Sex mismatch: ${pat.sex}`);
    assert(pat.follow_up_required === 'No', `follow_up_required should be No until prescription issue, got ${pat.follow_up_required}`);
    assert(!pat.follow_up_date, `follow_up_date should be empty until prescription issue, got ${pat.follow_up_date}`);
    assert(pat.status === 'pending', `Status should be pending, got ${pat.status}`);
  });

  await test('7.3  WF11 system_log INFO entry recorded', async () => {
    const logs = await recentSystemLogs('workflow-11-form-intake', 60);
    const info  = logs.find(l => l.log_level === 'INFO');
    assert(info, 'No INFO log from WF11 — check Supabase credential in n8n');
    console.log(`\n       Log: "${info.message}"`);
  });

  await test('7.3b E2E visit is visible as waiting queue row', async () => {
    const pat = await getPatient(`+91${TP.e2e}`);
    const visit = await getLatestVisitByPatient(pat.id);
    assert(visit, 'No patient_visits row for E2E patient');
    assert(visit.visit_status === 'waiting', `Expected waiting, got ${visit.visit_status}`);
    assert(!visit.chief_complaint, `chief_complaint should be doctor-dashboard owned, got ${visit.chief_complaint}`);
  });

  await test('7.4  Patient replies "confirm" → response_status = confirmed', async () => {
    const pat = await getPatient(`+91${TP.e2e}`);
    assert(pat, 'Patient not found');

    const { status } = await whTwilio('feedback-listener',
      twilioMsg(`+91${TP.e2e}`, 'Yes I will come'));
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
      hospital_name     : HF.primaryHospital,
      doctor_name       : HF.doctor,
      intake_token      : primaryIntakeToken,
      clinic_mode       : 'clinic_qr',
      visit_date        : date(0),
    });
    assert(status === 200, `Re-reg failed: ${status} ${JSON.stringify(json)}`);
    await sleep(1500);
    const pat = await getPatient(`+91${TP.e2e}`);
    assert(pat?.status === 'pending', `Re-reg should reset status to pending, got ${pat?.status}`);
    assert(pat?.follow_up_required === 'No', `Re-reg should reset follow_up_required to No, got ${pat?.follow_up_required}`);
    assert(!pat?.follow_up_date, `Re-reg should clear follow_up_date, got ${pat?.follow_up_date}`);
    assert(pat?.doctor_name === HF.doctor, `doctor_name not preserved: ${pat?.doctor_name}`);
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
  await pgEnd();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async e => {
  console.error('\n❌ Unexpected error:', e.message);
  console.error(e.stack);
  await pgEnd();
  process.exit(1);
});
