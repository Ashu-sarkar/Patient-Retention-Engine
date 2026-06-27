#!/usr/bin/env node
/**
 * Verifies demo clinic intake token resolves with doctors and WF11 accepts submission.
 *
 * Prerequisites: node scripts/seed-demo-clinic.mjs
 *
 *   node tests/demo-clinic-intake.test.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const manifestPath = path.join(repoRoot, 'build', 'demo-clinic-manifest.json');

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
const ANON_KEY = env.SUPABASE_ANON_KEY || '';
const WEBHOOK_BASE = (env.WEBHOOK_URL || 'https://vaitalcare-production.up.railway.app').replace(/\/$/, '');

let passed = 0;
let failed = 0;

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
  }
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

async function main() {
  if (!fs.existsSync(manifestPath)) {
    console.error(`❌ Run "node scripts/seed-demo-clinic.mjs" first — missing ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const { intake_token: token, scan_url: scanUrl, hospital_name: hospital, doctors } = manifest;

  console.log('\n── Demo clinic intake tests ──');
  console.log(`  Hospital: ${hospital}`);
  console.log(`  URL: ${scanUrl}\n`);

  await test('1.1  Token format is 64-char hex', () => {
    assert(/^[a-f0-9]{64}$/i.test(token), `bad token: ${token}`);
  });

  await test('1.2  resolve_public_intake_token returns doctors', async () => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/resolve_public_intake_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
      body: JSON.stringify({ p_token: token }),
    });
    assert(res.ok, `RPC failed (${res.status})`);
    const rows = await res.json();
    assert(Array.isArray(rows) && rows.length > 0, 'empty resolve result');
    assert(rows.every(r => r.clinic_id && r.doctor_name), 'missing clinic_id or doctor_name');
    assert(rows.length >= doctors.length, `expected ≥${doctors.length} doctors, got ${rows.length}`);
    const names = rows.map(r => r.doctor_name);
    for (const expected of doctors) {
      assert(names.includes(expected), `missing doctor "${expected}" in dropdown data`);
    }
  });

  await test('1.3  Patient form HTML loads at production URL', async () => {
    const base = scanUrl.split('/#/')[0];
    const res = await fetch(base, { redirect: 'follow' });
    assert(res.ok, `patient form host returned ${res.status}`);
    const html = await res.text();
    assert(html.includes('resolve_public_intake_token') || html.includes('doctor_name'),
      'page does not look like patient intake form');
  });

  await test('1.4  WF11 accepts intake with token + doctor', async () => {
    const doctor = doctors[0];
    const phone = `9810${String(Date.now()).slice(-6)}`;
    const payload = new URLSearchParams({
      patient_name: 'Demo Intake Test Patient',
      phone_number: phone,
      dob: '1990-06-15',
      sex: 'Female',
      hospital_name: hospital,
      doctor_name: doctor,
      intake_token: token,
      clinic_mode: 'clinic_qr',
      visit_date: todayISO(),
      follow_up_required: 'No',
      follow_up_date: '',
    });
    const res = await fetch(`${WEBHOOK_BASE}/webhook/patient-form-intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { _raw: text }; }
    assert(res.ok, `WF11 status ${res.status}: ${text.slice(0, 200)}`);
    assert(json.status === 'success', JSON.stringify(json));
    assert(json.patient_code, 'missing patient_code in response');
  });

  await test('1.5  WF11 rejects wrong doctor for token', async () => {
    const payload = new URLSearchParams({
      patient_name: 'Bad Doctor Test',
      phone_number: '9810999999',
      hospital_name: hospital,
      doctor_name: 'Dr. Nonexistent Fake',
      intake_token: token,
      clinic_mode: 'clinic_qr',
      visit_date: todayISO(),
    });
    const res = await fetch(`${WEBHOOK_BASE}/webhook/patient-form-intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload,
    });
    assert(!res.ok || (await res.json().catch(() => ({}))).status !== 'success',
      'expected rejection for invalid doctor');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
