#!/usr/bin/env node
/**
 * Browser E2E on production Vercel forms.
 * Phone: 9685722570 — OTP dashboard step is manual (headed mode).
 *
 *   npx playwright install chromium
 *   node tests/browser-production-e2e.mjs
 *
 * Env: HEADED=1 to show browser; DASHBOARD_OTP_PAUSE=1 to wait for manual OTP.
 */

import { chromium } from 'playwright';

const PHONE = process.env.E2E_PHONE_RAW || '9685722570';
const HOSPITAL = process.env.E2E_HOSPITAL || 'VaitalCare E2E Hospital';
const DOCTOR = process.env.E2E_DOCTOR || 'Dr Ashu E2E';
const PATIENT_URL = process.env.PATIENT_FORM_URL || 'https://vaitalcare-patient.vercel.app/';
const HOSPITAL_URL = process.env.HOSPITAL_FORM_URL || 'https://vaitalcare-hospital.vercel.app/';
const DASHBOARD_URL = process.env.DOCTOR_DASHBOARD_URL || '';
const HEADED = process.env.HEADED === '1' || process.env.HEADED === 'true';
const OTP_PAUSE = process.env.DASHBOARD_OTP_PAUSE === '1';

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

async function main() {
  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 80 : 0 });
  const page = await browser.newPage();
  const results = [];

  try {
    console.log('\n── Hospital form (production) ──');
    await page.goto(HOSPITAL_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await fillIfPresent(page, 'hospital_name', `${HOSPITAL} Browser`);
    await selectIfPresent(page, 'facility_type', 'Pathology Lab');
    await fillIfPresent(page, 'address', '99 Browser Test Road');
    await fillIfPresent(page, 'city', 'Bangalore');
    await fillIfPresent(page, 'contact_phone', PHONE);
    await fillIfPresent(page, 'admin_contact_name', 'Browser Admin');
    await fillIfPresent(page, 'doctor_name', `${DOCTOR} Browser`);
    await fillIfPresent(page, 'doctor_qualification', 'MBBS');
    await fillIfPresent(page, 'doctor_expertise', 'Internal Medicine');
    await fillIfPresent(page, 'doctor_registration_number', 'BR-96857');
    await fillIfPresent(page, 'doctor_phone', `+91${PHONE}`);
    await fillIfPresent(page, 'consultation_hours', 'Daily 10-6');
    await page.locator('#submit, button[type="submit"]').first().click();
    await page.waitForSelector('.success-screen.show, #success-screen.show', { timeout: 30000 }).catch(() => {});
    const hospOk = await page.locator('.success-screen.show, #success-screen.show').count() > 0;
    results.push(['hospital-form', hospOk ? 'pass' : 'fail']);
    console.log(hospOk ? '✅ Hospital form success screen' : '❌ Hospital form did not show success');

    console.log('\n── Patient form (production) ──');
    await page.goto(`${PATIENT_URL}?hospital=${encodeURIComponent(HOSPITAL)}`, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    await page.waitForTimeout(2000);
    await fillIfPresent(page, 'patient_name', 'Browser E2E Patient');
    await fillIfPresent(page, 'phone_number', PHONE);
    await fillIfPresent(page, 'dob', '1992-05-20');
    await selectIfPresent(page, 'sex', 'Male');
    const hSel = page.locator('#hospital_name');
    if (await hSel.count()) {
      const opts = await hSel.locator('option').allTextContents();
      const match = opts.find(o => o.toLowerCase().includes(HOSPITAL.toLowerCase().split(' ')[0]));
      if (match) await hSel.selectOption({ label: match });
      else if (opts.length > 1) await hSel.selectOption({ index: 1 });
    }
    await page.waitForTimeout(500);
    const dSel = page.locator('#doctor_name');
    if (await dSel.count() && !(await dSel.isDisabled())) {
      const dopts = await dSel.locator('option').allTextContents();
      const dmatch = dopts.find(o => o.includes('Ashu') || o.includes('E2E') || o.includes('Sharma'));
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

    if (DASHBOARD_URL) {
      console.log('\n── Doctor dashboard (OTP manual) ──');
      await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 60000 });
      await fillIfPresent(page, 'doctor-phone', `+91${PHONE}`);
      await page.locator('#login-submit, button[type="submit"]').first().click();
      console.log('⏸  Enter WhatsApp OTP in the browser, then verify sign-in.');
      if (OTP_PAUSE && HEADED) {
        await page.pause();
      } else {
        await page.waitForTimeout(120000);
      }
      const queue = await page.locator('.queue-card').count();
      results.push(['dashboard-queue', queue > 0 ? 'pass' : 'fail']);
      console.log(queue > 0 ? `✅ Dashboard shows ${queue} queue card(s)` : '❌ No queue cards visible');
    } else {
      console.log('\n(skip dashboard — set DOCTOR_DASHBOARD_URL to run OTP flow)');
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
