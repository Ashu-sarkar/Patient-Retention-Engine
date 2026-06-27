#!/usr/bin/env node
/**
 * Seed a realistic demo hospital with multiple doctors and mint a patient-intake QR token.
 *
 * Usage:
 *   node scripts/seed-demo-clinic.mjs
 *   ADMIN_USERNAME=ashu ADMIN_PASSWORD='...' node scripts/seed-demo-clinic.mjs
 *
 * Outputs scan URL, doctor list, and saves QR PNG to build/demo-clinic-qr.png
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
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
const ANON_KEY = env.SUPABASE_ANON_KEY || '';
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
const WEBHOOK_BASE = (env.WEBHOOK_URL || 'https://vaitalcare-production.up.railway.app').replace(/\/$/, '');
const PATIENT_FORM_BASE = (process.env.PATIENT_FORM_URL || 'https://vaitalcare-patient.vercel.app').replace(/\/+$/, '');
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'ashu').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ashu1501@';
const AUTH_DOMAIN = 'auth.vaitalcare.local';

const HOSPITAL_NAME = process.env.DEMO_HOSPITAL || 'Columbia Asia Hospital, Hebbal';
const FACILITY_TYPE = 'Multi-specialty Clinic';

const DOCTORS = [
  {
    doctor_name: 'Dr. Priya Nair',
    doctor_qualification: 'MBBS, MD (Cardiology)',
    doctor_expertise: 'Cardiology — interventional cardiology and heart failure',
    doctor_registration_number: 'KMC-45231',
    doctor_phone: '+919810000001',
    login_username: 'demo.priya.nair',
    password: 'DemoPass123',
  },
  {
    doctor_name: 'Dr. Rajesh Kumar',
    doctor_qualification: 'MBBS, MS (Orthopedics)',
    doctor_expertise: 'Orthopedics — joint replacement and sports injuries',
    doctor_registration_number: 'MCI-78234',
    doctor_phone: '+919810000002',
    login_username: 'demo.rajesh.kumar',
    password: 'DemoPass123',
  },
  {
    doctor_name: 'Dr. Ananya Sharma',
    doctor_qualification: 'MBBS, MD (Dermatology)',
    doctor_expertise: 'Dermatology — clinical and cosmetic dermatology',
    doctor_registration_number: 'DMC-90876',
    doctor_phone: '+919810000003',
    login_username: 'demo.ananya.sharma',
    password: 'DemoPass123',
  },
  {
    doctor_name: 'Dr. Vikram Mehta',
    doctor_qualification: 'MBBS, DNB (General Medicine)',
    doctor_expertise: 'General Medicine — diabetes, hypertension, and primary care',
    doctor_registration_number: 'TNMC-33102',
    doctor_phone: '+919810000004',
    login_username: 'demo.vikram.mehta',
    password: 'DemoPass123',
  },
];

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`✅ ${msg}`);
}

async function sbFetch(endpoint, { token, method = 'GET', body, key = ANON_KEY } = {}) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${token || key}`,
    'Content-Type': 'application/json',
  };
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
    `/rest/v1/hospital_boarding?hospital_name=eq.${encodeURIComponent(HOSPITAL_NAME)}&select=clinic_id,doctor_name&order=created_at.asc`,
    { key: SERVICE_KEY },
  );
  if (!res.ok) fail(`Could not query hospital_boarding: ${JSON.stringify(res.json)}`);
  return Array.isArray(res.json) ? res.json : [];
}

async function boardHospital() {
  const primary = DOCTORS[0];
  const payload = {
    hospital_name: HOSPITAL_NAME,
    facility_type: FACILITY_TYPE,
    address: '23/4, Bellary Road, Hebbal, Bengaluru, Karnataka 560024',
    city: 'Bengaluru',
    contact_phone: '+919810000000',
    admin_contact_name: 'Front Desk — Columbia Asia',
    clinic_logo_url: '',
    clinic_email: 'frontdesk.hebbal@columbiaasia.demo',
    clinic_website: 'https://www.columbiaasia.com',
    consultation_hours: 'Mon–Sat 8:00 AM – 8:00 PM, Sun 9:00 AM – 2:00 PM',
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
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok || json.status !== 'success') {
    fail(`Hospital boarding failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

async function adminSignIn() {
  const login = await sbFetch('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: `${ADMIN_USERNAME}@${AUTH_DOMAIN}`, password: ADMIN_PASSWORD },
  });
  if (!login.ok) fail(`Admin login failed (${login.status}): ${JSON.stringify(login.json)}`);
  const accessToken = login.json?.access_token;
  if (!accessToken) fail('No access token returned');
  return accessToken;
}

async function mintIntakeToken(accessToken, clinicId) {
  const label = `Demo QR — ${HOSPITAL_NAME}`;
  const tokenRes = await sbFetch('/rest/v1/rpc/create_clinic_intake_token', {
    token: accessToken,
    method: 'POST',
    body: {
      p_clinic_id: clinicId,
      p_label: label,
      p_expires_at: null,
    },
  });
  if (!tokenRes.ok) fail(`create_clinic_intake_token failed: ${JSON.stringify(tokenRes.json)}`);
  const row = Array.isArray(tokenRes.json) ? tokenRes.json[0] : tokenRes.json;
  const rawToken = row?.token;
  if (!/^[a-f0-9]{64}$/i.test(rawToken || '')) fail(`Unexpected token format: ${rawToken}`);
  return { rawToken, label };
}

async function resolveToken(rawToken) {
  const res = await sbFetch('/rest/v1/rpc/resolve_public_intake_token', {
    method: 'POST',
    body: { p_token: rawToken },
  });
  if (!res.ok) fail(`resolve_public_intake_token failed: ${JSON.stringify(res.json)}`);
  return Array.isArray(res.json) ? res.json : [];
}

function saveQrPng(scanUrl) {
  const buildDir = path.join(repoRoot, 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  const outPath = path.join(buildDir, 'demo-clinic-qr.png');
  try {
    execSync(`npx --yes qrcode -o "${outPath}" "${scanUrl}"`, {
      stdio: 'pipe',
      cwd: repoRoot,
    });
    return outPath;
  } catch (err) {
    console.warn(`⚠️  Could not generate QR PNG (install qrcode CLI failed): ${err.message}`);
    return '';
  }
}

function saveManifest({ clinicId, rawToken, scanUrl, doctors, qrPath }) {
  const buildDir = path.join(repoRoot, 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  const manifest = {
    hospital_name: HOSPITAL_NAME,
    clinic_id: clinicId,
    intake_token: rawToken,
    scan_url: scanUrl,
    doctors: doctors.map(d => d.doctor_name),
    qr_png: qrPath || null,
    created_at: new Date().toISOString(),
  };
  const manifestPath = path.join(buildDir, 'demo-clinic-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifestPath;
}

async function main() {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    fail('SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY required in .env');
  }

  console.log(`\n── Demo clinic seed: ${HOSPITAL_NAME} ──\n`);

  let boardingRows = await getExistingBoarding();
  if (boardingRows.length >= DOCTORS.length) {
    ok(`Hospital already onboarded (${boardingRows.length} doctor row(s))`);
  } else {
    console.log('Boarding hospital via WF12…');
    await boardHospital();
    await new Promise(r => setTimeout(r, 2000));
    boardingRows = await getExistingBoarding();
    if (boardingRows.length === 0) fail('Hospital boarding completed but no rows found in Supabase');
    ok(`Onboarded ${boardingRows.length} doctor(s)`);
  }

  const clinicId = boardingRows[0]?.clinic_id;
  if (!clinicId) fail('Could not resolve clinic_id from hospital_boarding');

  const doctorNames = boardingRows.map(r => r.doctor_name).filter(Boolean);
  console.log(`   Clinic ID: ${clinicId}`);
  console.log(`   Doctors: ${doctorNames.join(', ')}`);

  console.log('\n── Mint intake QR token ──');
  const accessToken = await adminSignIn();
  ok(`Signed in as ${ADMIN_USERNAME} (platform admin)`);
  const { rawToken } = await mintIntakeToken(accessToken, clinicId);
  const scanUrl = `${PATIENT_FORM_BASE}/#/i/${rawToken}`;
  ok(`Token minted`);
  console.log(`   Scan URL: ${scanUrl}`);

  console.log('\n── Verify token resolves (patient form RPC) ──');
  const resolved = await resolveToken(rawToken);
  if (resolved.length === 0) fail('Token resolved to zero doctors — patient form will be locked');
  const resolvedDoctors = resolved.map(r => r.doctor_name).filter(Boolean);
  const resolvedHospital = resolved[0]?.hospital_name || '';
  if (resolvedHospital !== HOSPITAL_NAME) {
    console.warn(`⚠️  hospital_name mismatch: expected "${HOSPITAL_NAME}", got "${resolvedHospital}"`);
  }
  if (resolvedDoctors.length < 1) fail('No doctors returned from resolve_public_intake_token');
  ok(`Token resolves to "${resolvedHospital}" with ${resolvedDoctors.length} doctor(s)`);
  resolvedDoctors.forEach(name => console.log(`   • ${name}`));

  console.log('\n── Generate QR code ──');
  const qrPath = saveQrPng(scanUrl);
  if (qrPath) ok(`QR saved to ${qrPath}`);

  const manifestPath = saveManifest({
    clinicId,
    rawToken,
    scanUrl,
    doctors: DOCTORS,
    qrPath,
  });
  ok(`Manifest saved to ${manifestPath}`);

  console.log('\n── Doctor dashboard logins (for testing) ──');
  DOCTORS.forEach(d => {
    console.log(`   ${d.doctor_name}: username "${d.login_username}" / password "${d.password}"`);
  });

  console.log('\n[seed-demo-clinic] Done. Open the scan URL in a browser to verify the patient form.\n');
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
