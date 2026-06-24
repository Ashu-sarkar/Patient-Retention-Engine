#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'admin-console', 'index.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'schemas', 'migration-admin-console.sql'), 'utf8');
const patientForm = fs.readFileSync(path.join(root, 'patient-form', 'index.html'), 'utf8');
const hospitalForm = fs.readFileSync(path.join(root, 'hospital-form', 'index.html'), 'utf8');
const hospitalWorkflow = fs.readFileSync(path.join(root, 'workflows', 'workflow-12-hospital-boarding.json'), 'utf8');
const hospitalWorkflowJson = JSON.parse(hospitalWorkflow);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const bootstrapScript = fs.readFileSync(path.join(root, 'scripts', 'bootstrap-platform-admin.js'), 'utf8');
const securityDocs = fs.readFileSync(path.join(root, 'docs', 'security-hardening.md'), 'utf8');
const adminE2e = fs.readFileSync(path.join(root, 'tests', 'admin-console-production-e2e.mjs'), 'utf8');

function includes(haystack, needle, label) {
  assert(haystack.includes(needle), `${label || 'Expected content'} missing: ${needle}`);
}

// ── Admin console page ──────────────────────────────────────────────────────
includes(admin, 'signInWithPassword', 'admin uses username/password auth');
includes(admin, 'function usernameToInternalEmail(username)', 'admin maps username to internal auth email');
includes(admin, "const AUTH_USERNAME_EMAIL_DOMAIN = 'auth.vaitalcare.local';", 'admin internal auth email domain');
includes(admin, "rpc('current_user_is_platform_admin')", 'admin verifies platform-admin server-side');
includes(admin, 'This account is not a platform administrator.', 'non-admin sign-in is rejected');
includes(admin, "sb.auth.signOut()", 'non-admin session is signed out');
includes(admin, "rpc('admin_list_clinics')", 'clinic listing wired to gated RPC');
includes(admin, "rpc('admin_get_clinic_details'", 'clinic detail view wired to gated RPC');
includes(admin, "rpc('admin_get_platform_overview')", 'platform overview wired to gated RPC');
includes(admin, "rpc('admin_get_operations_overview')", 'operations overview wired to gated RPC');
includes(admin, "rpc('admin_get_security_support_overview')", 'security/support overview wired to gated RPC');
includes(admin, "rpc('admin_update_clinic_admin_settings'", 'manual clinic SaaS settings wired to gated RPC');
includes(admin, 'Manual payment status', 'admin can manually track payment status');
assert(!admin.includes("rpc('admin_create_clinic'"), 'admin console must NOT create clinics (onboarding form owns registration)');
includes(admin, "rpc('create_clinic_intake_token'", 'token generation wired to RPC');
includes(admin, "rpc('admin_list_intake_tokens'", 'token listing wired to RPC');
includes(admin, "rpc('admin_set_token_status'", 'token disable/enable wired to RPC');
includes(admin, "rpc('admin_seed_dummy_patients'", 'demo seed wired to RPC');
includes(admin, "rpc('admin_clear_dummy_patients'", 'demo clear wired to RPC');
includes(admin, '/#/i/${token}', 'QR encodes hash-fragment intake token URL');
includes(admin, "const DEFAULT_PATIENT_FORM_BASE_URL = 'https://vaitalcare-patient.vercel.app'", 'admin defaults QR base URL to production patient form');
includes(admin, './vendor/qrcode.min.js', 'vendored offline QR library is referenced');
includes(admin, 'qrcode(0,', 'QR is rendered client-side from the vendored library');
includes(admin, "toDataURL('image/png')", 'QR can be downloaded as PNG');

// Vendored library is present.
assert(
  fs.existsSync(path.join(root, 'admin-console', 'vendor', 'qrcode.min.js')),
  'admin-console/vendor/qrcode.min.js must be vendored for offline QR generation'
);

// ── Migration: gated admin RPCs + demo tagging + platform admin ─────────────
includes(migration, 'CREATE TABLE IF NOT EXISTS public.platform_admins', 'platform_admins table');
includes(migration, 'FROM public.platform_admins pa', 'platform admin check reads platform_admins');
includes(migration, 'CREATE TABLE IF NOT EXISTS public.platform_clinic_admin_settings', 'manual SaaS admin settings table');
includes(migration, "payment_status IN ('not_started','trial','paid','due','overdue','waived','paused','payment_failed','cancelled')", 'manual payment statuses are constrained');
includes(migration, 'FUNCTION public.admin_update_clinic_admin_settings', 'manual clinic admin settings RPC');
includes(migration, 'FUNCTION public.admin_get_platform_overview', 'platform overview RPC');
includes(migration, 'FUNCTION public.admin_get_operations_overview', 'operations overview RPC');
includes(migration, 'FUNCTION public.admin_get_security_support_overview', 'security/support overview RPC');
includes(migration, 'ADD COLUMN IF NOT EXISTS is_demo', 'is_demo tagging columns');
includes(migration, 'DROP FUNCTION IF EXISTS public.admin_create_clinic', 'admin_create_clinic is removed (onboarding owns registration)');
includes(migration, 'FUNCTION public.admin_list_clinics', 'admin_list_clinics RPC');
includes(migration, 'FUNCTION public.admin_get_clinic_details', 'admin_get_clinic_details RPC');
includes(migration, 'FUNCTION public.admin_seed_dummy_patients', 'admin_seed_dummy_patients RPC');
includes(migration, 'FUNCTION public.admin_clear_dummy_patients', 'admin_clear_dummy_patients RPC');
includes(migration, "RAISE EXCEPTION 'not authorized to seed demo patients'", 'seeding is admin-gated');
includes(migration, "'+999'", 'demo phones use the unassigned +999 country code');
includes(migration, "'draft'", 'demo prescriptions stay draft so cleanup can delete them');
includes(migration, 'platform admin reads patients', 'platform-admin read RLS for patients');
includes(migration, 'FOR SELECT TO authenticated', 'platform-admin policies are read-only');

assert(pkg.scripts['bootstrap:platform-admin'] === 'node scripts/bootstrap-platform-admin.js', 'package exposes platform admin bootstrap command');
assert(!pkg.scripts['sync:doctor-otp-secrets'], 'package must not expose stale doctor OTP setup');
includes(bootstrapScript, '/auth/v1/admin/users', 'bootstrap creates Supabase Auth admin users');
includes(bootstrapScript, '/rest/v1/platform_admins?on_conflict=user_id', 'bootstrap upserts platform_admins');
includes(bootstrapScript, "AUTH_USERNAME_EMAIL_DOMAIN = 'auth.vaitalcare.local'", 'bootstrap shares username email domain');
includes(securityDocs, 'npm run bootstrap:platform-admin', 'security docs document first-admin bootstrap');

includes(adminE2e, 'ADMIN_CONSOLE_URL', 'live admin E2E requires admin console URL');
includes(adminE2e, '#login-btn', 'live admin E2E covers login');
includes(adminE2e, '#clinics-table table tr[data-clinic]', 'live admin E2E covers clinic list');
includes(adminE2e, '#qr-generate', 'live admin E2E covers QR creation');
includes(adminE2e, '[data-disable]', 'live admin E2E covers token disable');
includes(adminE2e, '[data-enable]', 'live admin E2E covers token enable');
includes(adminE2e, '#demo-seed', 'live admin E2E covers demo seed');
includes(adminE2e, '#demo-clear', 'live admin E2E covers demo clear');
includes(adminE2e, '#dash-stats .stat', 'live admin E2E covers dashboard counts');

// ── Workflows must exclude demo patients ─────────────────────────────────────
for (const [file, label] of [
  ['workflow-1-followup-reminder.json', 'WF1'],
  ['workflow-2-sameday-reminder.json', 'WF2'],
  ['workflow-3-missed-appointment.json', 'WF3'],
  ['workflow-4-health-check.json', 'WF4'],
  ['workflow-5-reactivation.json', 'WF5'],
]) {
  const wf = fs.readFileSync(path.join(root, 'workflows', file), 'utf8');
  includes(wf, 'COALESCE(p.is_demo, FALSE) = FALSE', `${label} excludes demo patients from messaging`);
}

// ── Patient form is token-only (no public clinic directory dropdown) ─────────
includes(patientForm, "location.pathname || '').match(/\\/i\\/([a-f0-9]{64})", 'patient form parses path-based token');
includes(patientForm, 'resolve_public_intake_token', 'patient form resolves clinic from intake token');
includes(patientForm, "clinic_mode:        'clinic_qr'", 'patient form submits clinic_qr mode');
assert(!patientForm.includes('get_public_hospital_list'), 'patient form must not load public hospital directory');
assert(!patientForm.includes('shared_qr'), 'patient form must not support shared_qr mode');
assert(!patientForm.includes('id="hospital_name"'), 'patient form must not expose hospital dropdown');

// ── Hospital onboarding supports multiple doctors + secure password handling ──
includes(hospitalForm, 'id="doctor_count"', 'hospital form collects doctor count');
includes(hospitalForm, 'doctors_json: JSON.stringify(doctors)', 'hospital form posts doctors_json');
includes(hospitalForm, 'login_username', 'hospital form collects dashboard usernames');
includes(hospitalForm, 'password.length < 8', 'hospital form enforces minimum password length');
includes(hospitalWorkflow, 'Create Doctor Auth Users', 'workflow creates doctor auth users server-side');
includes(hospitalWorkflow, '/auth/v1/admin/users', 'workflow calls Supabase Auth Admin API');
includes(hospitalWorkflow, 'SUPABASE_SERVICE_ROLE_KEY', 'workflow uses service role only server-side');
includes(hospitalWorkflow, 'login_username, auth_user_id', 'workflow stores safe auth metadata');
const insertHospitalNode = hospitalWorkflowJson.nodes.find(node => node.name === 'Insert Hospital Row');
assert(insertHospitalNode, 'workflow must have Insert Hospital Row node');
assert(!/password|_password/i.test(insertHospitalNode.parameters.query), 'workflow must not insert password into hospital_boarding');

console.log('[admin-console-static] Passed.');
