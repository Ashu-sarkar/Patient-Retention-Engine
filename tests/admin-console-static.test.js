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

// ── Patient form supports path-based intake token in addition to hash ───────
includes(patientForm, "location.pathname || '').match(/\\/i\\/([a-f0-9]{64})", 'patient form parses path-based token');

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
