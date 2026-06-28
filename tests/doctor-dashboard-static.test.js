#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'doctor-dashboard', 'index.html'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const dashboardReadme = fs.readFileSync(path.join(root, 'doctor-dashboard', 'README.md'), 'utf8');
const setupGuide = fs.readFileSync(path.join(root, 'docs', 'setup-guide.md'), 'utf8');
const architecture = fs.readFileSync(path.join(root, 'docs', 'architecture.md'), 'utf8');
const pdfGateway = fs.readFileSync(path.join(root, 'supabase', 'functions', 'prescription-pdf', 'index.ts'), 'utf8');
const preflight = fs.readFileSync(path.join(root, 'schemas', 'preflight-migrations.sql'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'schemas', 'supabase-schema.sql'), 'utf8');

function includes(haystack, needle, label) {
  assert(
    haystack.includes(needle),
    `${label || 'Expected content'} missing: ${needle}`
  );
}

includes(dashboard, 'function minFollowUpDate()', 'dashboard follow-up minimum helper');
includes(dashboard, 'id="analytics-link"', 'doctor dashboard analytics nav link');
includes(dashboard, 'DEFAULT_DOCTOR_ANALYTICS_URL', 'doctor dashboard analytics URL config');
includes(dashboard, 'doctorAnalyticsUrl', 'doctor dashboard reads analytics URL from config');
includes(dashboard, ".eq('visit_date', $('visit-date').value || todayISO())", 'queue query filters by selected visit date');
includes(dashboard, "$('visit-date').addEventListener('change', loadVisits)", 'visit date change refetches queue');
includes(dashboard, 'const visitNext = state.selected?.visit_date ? addDaysISO(state.selected.visit_date, 1) : today;', 'visit+today minimum calculation');
includes(dashboard, 'return visitNext > today ? visitNext : today;', 'follow-up min must never be before today');
includes(dashboard, 'function validateFollowUp(payload)', 'shared follow-up validation');
includes(dashboard, "const AUTH_USERNAME_EMAIL_DOMAIN = 'auth.vaitalcare.local';", 'username auth email domain');
includes(dashboard, 'function usernameToInternalEmail(username)', 'username maps to internal auth email');
includes(dashboard, 'signInWithPassword', 'doctor dashboard uses username/password auth');
assert(!dashboard.includes('signInWithOtp'), 'doctor dashboard must not request WhatsApp OTP login');
assert(!dashboard.includes('verifyOtp'), 'doctor dashboard must not verify WhatsApp OTP login');
for (const [text, label] of [
  [readme, 'root README'],
  [dashboardReadme, 'doctor dashboard README'],
  [setupGuide, 'setup guide'],
  [architecture, 'architecture docs'],
]) {
  assert(!/WhatsApp OTP|phone OTP|sync:doctor-otp-secrets|after OTP verification/i.test(text), `${label} must not document stale doctor OTP auth`);
}
includes(dashboard, 'function isPreviewMode()', 'shared preview mode helper');
includes(dashboard, 'function enterAdminPreviewApp(username)', 'admin preview bootstrap');
includes(dashboard, 'Admin preview opened with sample patients.', 'admin preview success toast');
includes(dashboard, 'state.demo = true;', 'admin preview runs in local sandbox mode');
includes(dashboard, 'function isMedicineComplete(med = {})', 'medicine completion helper');
includes(dashboard, 'function canAddMedicine()', 'medicine add guard helper');
includes(dashboard, 'Complete the current medicine before adding another one.', 'medicine add guard copy');
includes(dashboard, "$('add-medicine').disabled = !canAdd;", 'add medicine button disabled until current row complete');
includes(dashboard, 'const followUpError = validateFollowUp(payload);', 'draft save follow-up validation');
includes(dashboard, 'input.required = required;', 'required follow-up date when enabled');
includes(dashboard, 'data-follow-days="7"', 'quick follow-up controls');
includes(dashboard, 'data-follow-days="30"', '30 day quick follow-up control');
includes(dashboard, 'id="form-alert"', 'inline validation alert');

includes(preflight, "IF NEW.follow_up_date < CURRENT_DATE THEN", 'preflight DB past follow-up guard');
includes(preflight, "RAISE EXCEPTION 'Follow-up date cannot be in the past';", 'preflight DB past follow-up error');
includes(schema, "IF NEW.follow_up_date < CURRENT_DATE THEN", 'reference schema past follow-up guard');

includes(pdfGateway, '.select(\'pdf_storage_path, status\')', 'PDF gateway loads durable storage path');
includes(pdfGateway, ".storage\n    .from('prescriptions')\n    .createSignedUrl(storagePath", 'PDF gateway creates a fresh storage signed URL');
assert(!pdfGateway.includes('Response.redirect(prescription.pdf_url'), 'PDF gateway must not redirect to stored expiring pdf_url');

console.log('[doctor-dashboard-static] Passed.');
