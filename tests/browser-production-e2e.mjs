#!/usr/bin/env node
/**
 * Browser E2E on production Vercel forms.
 * Phone: 9685722570.
 *
 *   npx playwright install chromium
 *   node tests/browser-production-e2e.mjs
 *
 * Env: HEADED=1 to show browser.
 * Optional: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to auto-seed clinic QR token after hospital boarding.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const env = { ...parseEnv(path.join(__dirname, '..', '.env')), ...process.env };
const SB_URL = env.SUPABASE_URL || '';
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';

const PHONE = process.env.E2E_PHONE_RAW || '9685722570';
const HOSPITAL = process.env.E2E_HOSPITAL || 'VaitalCare E2E Hospital';
const DOCTOR = process.env.E2E_DOCTOR || 'Dr Ashu E2E';
const PATIENT_URL = process.env.PATIENT_FORM_URL || 'https://vaitalcare-patient.vercel.app/';
const HOSPITAL_URL = process.env.HOSPITAL_FORM_URL || 'https://vaitalcare-hospital.vercel.app/';
const DASHBOARD_URL = process.env.DOCTOR_DASHBOARD_URL || '';
const DOCTOR_USERNAME = process.env.E2E_DOCTOR_USERNAME || 'browser.doctor';
const DOCTOR_PASSWORD = process.env.E2E_DOCTOR_PASSWORD || 'BrowserPass123';
const HEADED = process.env.HEADED === '1' || process.env.HEADED === 'true';

function newIntakeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function sbGet(table, qs = '') {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
    },
  });
  return res.json().catch(() => []);
}

async function sbPost(table, body, qs = '') {
  const res = await fetch(`${SB_URL}/rest/v1/${table}${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${table} insert failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function seedIntakeTokenForHospital(hospitalName) {
  if (!SB_URL || !SB_KEY) return process.env.E2E_INTAKE_TOKEN || '';
  const rows = await sbGet(
    'hospital_boarding',
    `hospital_name=eq.${encodeURIComponent(hospitalName)}&select=clinic_id&order=created_at.desc&limit=1`
  );
  const clinicId = rows[0]?.clinic_id;
  if (!clinicId) return '';
  const token = newIntakeToken();
  await sbPost('clinic_intake_tokens', {
    clinic_id: clinicId,
    token_hash: tokenHash(token),
    label: 'Browser E2E QR',
    status: 'active',
  });
  return token;
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

async function fillIfPresent(page, id, value) {
  const el = page.locator(`#${id}`);
  if (await el.count()) await el.fill(value);
}

async function selectIfPresent(page, id, value) {
  const el = page.locator(`#${id}`);
  if (await el.count()) await el.selectOption({ label: value }).catch(() => el.selectOption(value));
}

async function fillMedicineRow(page) {
  const rows = page.locator('.medicine-row');
  if ((await rows.count()) === 0) {
    await page.locator('#add-medicine').click();
  }
  const row = page.locator('.medicine-row').first();
  await row.locator('[data-key="medicine_name"]').fill('Paracetamol');
  await row.locator('[data-key="dosage"]').fill('500 mg');
  await row.locator('[data-key="frequency"]').fill('1-0-1');
  await row.locator('[data-key="timing"]').selectOption({ label: 'After Food' }).catch(() => row.locator('[data-key="timing"]').selectOption({ index: 1 }));
  await row.locator('[data-key="duration"]').fill('3 days');
  const instructions = row.locator('[data-key="instructions"]');
  if (await instructions.count()) await instructions.fill('Take with water after meals.');
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 80 : 0 });
  const page = await browser.newPage();
  const results = [];
  const dashboardSignals = {
    storageUpload: false,
    storageSign: false,
    deliveryFunction: false,
  };
  page.on('response', response => {
    const url = response.url();
    if (url.includes('/storage/v1/object/prescriptions')) dashboardSignals.storageUpload = true;
    if (url.includes('/storage/v1/object/sign/prescriptions')) dashboardSignals.storageSign = true;
    if (url.includes('/functions/v1/prescription-delivery')) dashboardSignals.deliveryFunction = true;
  });

  try {
    console.log('\n── Hospital form (production) ──');
    await page.goto(HOSPITAL_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await fillIfPresent(page, 'hospital_name', `${HOSPITAL} Browser`);
    await selectIfPresent(page, 'facility_type', 'Pathology Lab');
    await fillIfPresent(page, 'address', '99 Browser Test Road');
    await fillIfPresent(page, 'city', 'Bangalore');
    await fillIfPresent(page, 'contact_phone', PHONE);
    await fillIfPresent(page, 'admin_contact_name', 'Browser Admin');
    await fillIfPresent(page, 'doctor_0_name', `${DOCTOR} Browser`);
    await fillIfPresent(page, 'doctor_0_qualification', 'MBBS');
    await fillIfPresent(page, 'doctor_0_expertise', 'Internal Medicine');
    await fillIfPresent(page, 'doctor_0_registration_number', 'BR-96857');
    await fillIfPresent(page, 'doctor_0_phone', `+91${PHONE}`);
    await fillIfPresent(page, 'doctor_0_username', DOCTOR_USERNAME);
    await fillIfPresent(page, 'doctor_0_password', DOCTOR_PASSWORD);
    await fillIfPresent(page, 'consultation_hours', 'Daily 10-6');
    await page.locator('#submit, button[type="submit"]').first().click();
    await page.waitForSelector('.success-screen.show, #success-screen.show', { timeout: 30000 }).catch(() => {});
    const hospOk = await page.locator('.success-screen.show, #success-screen.show').count() > 0;
    results.push(['hospital-form', hospOk ? 'pass' : 'fail']);
    console.log(hospOk ? '✅ Hospital form success screen' : '❌ Hospital form did not show success');

    console.log('\n── Patient form (production) ──');
    const browserHospital = `${HOSPITAL} Browser`;
    const intakeToken = await seedIntakeTokenForHospital(browserHospital);
    if (!intakeToken) {
      console.log('❌ Patient form skipped — set SUPABASE_* in .env or E2E_INTAKE_TOKEN for clinic QR URL');
      results.push(['patient-form', 'skip']);
    } else {
      const patientUrl = `${PATIENT_URL.replace(/\/$/, '')}/#/i/${intakeToken}`;
      await page.goto(patientUrl, {
        waitUntil: 'networkidle',
        timeout: 60000,
      });
      await page.waitForTimeout(2000);
      await fillIfPresent(page, 'patient_name', 'Browser E2E Patient');
      await fillIfPresent(page, 'phone_number', PHONE);
      await fillIfPresent(page, 'dob', '1992-05-20');
      await selectIfPresent(page, 'sex', 'Male');
      const dSel = page.locator('#doctor_name');
      if (await dSel.count()) {
        await page.waitForFunction(() => {
          const sel = document.getElementById('doctor_name');
          return sel && !sel.disabled && sel.options.length > 1;
        }, { timeout: 15000 }).catch(() => {});
      }
      if (await dSel.count() && !(await dSel.isDisabled())) {
        const dopts = await dSel.locator('option').allTextContents();
        const dmatch = dopts.find(o => o.includes('Ashu') || o.includes('E2E') || o.includes('Browser'));
        if (dmatch) await dSel.selectOption({ label: dmatch });
        else if (dopts.length > 1) await dSel.selectOption({ index: 1 });
      }
      await fillIfPresent(page, 'visit_date', todayISO());
      await selectIfPresent(page, 'follow_up_required', 'No');
      await page.locator('#submit, button[type="submit"]').first().click();
      await page.waitForSelector('.success-screen.show, #success-screen.show', { timeout: 45000 }).catch(() => {});
      const codeVisible = await page.locator('#js-code-value, .code-value').count();
      const patOk = await page.locator('.success-screen.show, #success-screen.show').count() > 0;
      results.push(['patient-form', patOk ? 'pass' : 'fail']);
      console.log(patOk ? `✅ Patient form success${codeVisible ? ' (patient code shown)' : ''}` : '❌ Patient form failed');
    }

    if (DASHBOARD_URL) {
      console.log('\n── Doctor dashboard (username/password) ──');
      await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 60000 });
      await fillIfPresent(page, 'doctor-username', DOCTOR_USERNAME);
      await fillIfPresent(page, 'doctor-password', DOCTOR_PASSWORD);
      await page.locator('#login-submit, button[type="submit"]').first().click();
      await page.waitForSelector('.queue-card, #empty-state', { timeout: 45000 }).catch(() => {});
      const queue = await page.locator('.queue-card').count();
      results.push(['dashboard-queue', queue > 0 ? 'pass' : 'fail']);
      console.log(queue > 0 ? `✅ Dashboard shows ${queue} queue card(s)` : '❌ No queue cards visible');

      if (queue > 0) {
        console.log('\n── Doctor dashboard prescription issue ──');
        const patientCard = page.locator('.queue-card').filter({ hasText: 'Browser E2E Patient' }).first();
        if (await patientCard.count()) await patientCard.click();
        else await page.locator('.queue-card').first().click();
        await page.waitForSelector('#diagnosis', { timeout: 30000 });

        await fillIfPresent(page, 'chief-input', 'Browser E2E cough and fever');
        await fillIfPresent(page, 'duration-input', '2 days');
        await fillIfPresent(page, 'allergies-input', 'None known');
        await fillIfPresent(page, 'vitals-input', 'Temp 99 F, pulse 82');
        const saveContext = page.locator('#save-context');
        if (await saveContext.count()) {
          await saveContext.click();
          await page.waitForTimeout(1200);
        }

        await fillIfPresent(page, 'diagnosis', 'Viral upper respiratory infection');
        await fillIfPresent(page, 'remarks', 'Hydration and rest advised.');
        await fillIfPresent(page, 'advice', 'Return if fever persists beyond 3 days.');
        await selectIfPresent(page, 'rx-follow-up-required', 'No');
        await fillMedicineRow(page);

        await page.locator('#issue').click();
        await page.waitForFunction(() => {
          const draft = document.querySelector('#draft-state')?.textContent || '';
          const toast = document.querySelector('#toast')?.textContent || '';
          return /Issued/i.test(draft) || /Prescription issued/i.test(toast);
        }, { timeout: 90000 }).catch(() => {});

        const issued = /Issued/i.test(await page.locator('#draft-state').textContent().catch(() => ''));
        const pdfStored = dashboardSignals.storageUpload || dashboardSignals.storageSign;
        const deliveryCalled = dashboardSignals.deliveryFunction;
        results.push(['dashboard-prescription-issued', issued ? 'pass' : 'fail']);
        results.push(['dashboard-pdf-storage', pdfStored ? 'pass' : 'fail']);
        results.push(['dashboard-delivery-handoff', deliveryCalled ? 'pass' : 'fail']);
        console.log(issued ? '✅ Prescription reached issued state' : '❌ Prescription did not reach issued state');
        console.log(pdfStored ? '✅ PDF storage/signing observed' : '❌ PDF storage/signing was not observed');
        console.log(deliveryCalled ? '✅ Prescription delivery function called' : '❌ Delivery function call was not observed');
      }
    } else {
      console.log('\n(skip dashboard — set DOCTOR_DASHBOARD_URL to run dashboard login)');
    }
  } finally {
    await browser.close();
  }

  console.log('\nBrowser results:', Object.fromEntries(results));
  const failed = results.filter(([, s]) => s === 'fail').length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
