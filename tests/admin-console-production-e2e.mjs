#!/usr/bin/env node
/**
 * Browser E2E for the production admin console.
 *
 *   ADMIN_CONSOLE_URL=https://... \
 *   ADMIN_USERNAME=founder \
 *   ADMIN_PASSWORD=... \
 *   npx playwright install chromium \
 *   npm run test:production-admin
 */

import { chromium } from 'playwright';

const ADMIN_URL = process.env.ADMIN_CONSOLE_URL || process.env.ADMIN_URL || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || process.env.PLATFORM_ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.PLATFORM_ADMIN_PASSWORD || '';
const PATIENT_FORM_BASE_URL = process.env.PATIENT_FORM_URL || 'https://vaitalcare-patient.vercel.app/';
const HEADED = process.env.HEADED === '1' || process.env.HEADED === 'true';

function requireEnv(name, value) {
  if (!value) throw new Error(`${name} is required`);
}

async function selectFirstClinic(page, selector) {
  const select = page.locator(selector);
  await select.waitFor({ timeout: 30000 });
  await page.waitForFunction(sel => {
    const el = document.querySelector(sel);
    return el && el.options && el.options.length > 1 && el.value;
  }, selector, { timeout: 45000 });
  return select.inputValue();
}

async function main() {
  requireEnv('ADMIN_CONSOLE_URL', ADMIN_URL);
  requireEnv('ADMIN_USERNAME', ADMIN_USERNAME);
  requireEnv('ADMIN_PASSWORD', ADMIN_PASSWORD);

  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 80 : 0 });
  const page = await browser.newPage();
  const results = [];
  page.on('dialog', dialog => dialog.accept());

  try {
    console.log('\n── Admin login ──');
    await page.goto(ADMIN_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.locator('#username').fill(ADMIN_USERNAME);
    await page.locator('#password').fill(ADMIN_PASSWORD);
    await page.locator('#login-btn').click();
    await page.waitForSelector('#app:not(.hidden)', { timeout: 45000 });
    results.push(['admin-login', 'pass']);
    console.log('✅ Admin logged in');

    await page.waitForSelector('#overview-stats .stat', { timeout: 45000 });
    const overviewStats = await page.locator('#overview-stats .stat').count();
    results.push(['overview-counts', overviewStats > 0 ? 'pass' : 'fail']);
    console.log(overviewStats > 0 ? `✅ Overview rendered ${overviewStats} stat(s)` : '❌ Overview stats missing');

    console.log('\n── Clinic list ──');
    await page.locator('[data-tab="clinics"]').click();
    await page.waitForSelector('#clinics-table table tr[data-clinic]', { timeout: 45000 });
    const clinicRows = await page.locator('#clinics-table table tr[data-clinic]').count();
    results.push(['clinic-list', clinicRows > 0 ? 'pass' : 'fail']);
    console.log(clinicRows > 0 ? `✅ Clinic list rendered ${clinicRows} row(s)` : '❌ Clinic list missing');

    console.log('\n── QR token lifecycle ──');
    await page.locator('[data-tab="qr"]').click();
    await selectFirstClinic(page, '#qr-clinic');
    await page.locator('#form-base').fill(PATIENT_FORM_BASE_URL);
    await page.locator('#qr-label').fill(`E2E QR ${Date.now()}`);
    await page.locator('#qr-generate').click();
    await page.waitForSelector('#qr-result:not(.hidden) #qr-url', { timeout: 45000 });
    const scanUrl = await page.locator('#qr-url').textContent();
    const qrOk = /\/#\/i\/[a-f0-9]{64}/i.test(scanUrl || '') || /\/i\/[a-f0-9]{64}/i.test(scanUrl || '');
    results.push(['qr-create', qrOk ? 'pass' : 'fail']);
    console.log(qrOk ? '✅ QR token generated' : `❌ Unexpected QR URL: ${scanUrl}`);

    await page.waitForSelector('#tokens-table table', { timeout: 45000 });
    const disable = page.locator('#tokens-table [data-disable]').first();
    await disable.click();
    await page.waitForSelector('#tokens-table [data-enable]', { timeout: 45000 });
    const disabledVisible = await page.locator('#tokens-table .pill.disabled').count();
    results.push(['qr-disable', disabledVisible > 0 ? 'pass' : 'fail']);
    console.log(disabledVisible > 0 ? '✅ Token disabled' : '❌ Token disable not visible');

    await page.locator('#tokens-table [data-enable]').first().click();
    await page.waitForSelector('#tokens-table [data-disable]', { timeout: 45000 });
    const activeVisible = await page.locator('#tokens-table .pill.active').count();
    results.push(['qr-enable', activeVisible > 0 ? 'pass' : 'fail']);
    console.log(activeVisible > 0 ? '✅ Token re-enabled' : '❌ Token enable not visible');

    console.log('\n── Demo seed/clear ──');
    await page.locator('[data-tab="demo"]').click();
    await selectFirstClinic(page, '#demo-clinic');
    await page.locator('#demo-count').fill('2');
    await page.locator('#demo-seed').click();
    await page.waitForTimeout(2500);
    const seedToast = await page.locator('#toast').textContent().catch(() => '');
    const seeded = /Seeded/i.test(seedToast || '');
    results.push(['demo-seed', seeded ? 'pass' : 'fail']);
    console.log(seeded ? '✅ Demo patients seeded' : `❌ Demo seed toast missing: ${seedToast}`);

    await page.locator('#demo-clear').click();
    await page.waitForTimeout(2500);
    const clearToast = await page.locator('#toast').textContent().catch(() => '');
    const cleared = /Cleared/i.test(clearToast || '');
    results.push(['demo-clear', cleared ? 'pass' : 'fail']);
    console.log(cleared ? '✅ Demo patients cleared' : `❌ Demo clear toast missing: ${clearToast}`);

    console.log('\n── Clinic dashboard counts ──');
    await page.locator('[data-tab="dashboard"]').click();
    await selectFirstClinic(page, '#dash-clinic');
    await page.locator('#dash-load').click();
    await page.waitForSelector('#dash-stats .stat', { timeout: 45000 });
    const dashStats = await page.locator('#dash-stats .stat').count();
    results.push(['dashboard-counts', dashStats > 0 ? 'pass' : 'fail']);
    console.log(dashStats > 0 ? `✅ Dashboard rendered ${dashStats} stat(s)` : '❌ Dashboard stats missing');
  } finally {
    await browser.close();
  }

  console.log('\nAdmin console results:', Object.fromEntries(results));
  const failed = results.filter(([, status]) => status === 'fail').length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
