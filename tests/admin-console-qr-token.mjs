#!/usr/bin/env node
/**
 * Integration test: platform admin creates a per-clinic intake token and
 * the patient form anon RPC resolves it to the correct hospital.
 *
 *   ADMIN_USERNAME=ashu ADMIN_PASSWORD='Ashu1501@' node tests/admin-console-qr-token.mjs
 */

import fs from 'fs';
import path from 'path';

const repoRoot = path.join(import.meta.dirname, '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(repoRoot, '.env'), 'utf8')
    .split('\n')
    .filter(line => line.trim() && !line.trim().startsWith('#') && line.includes('='))
    .map(line => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

const SUPABASE_URL = (env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY = env.SUPABASE_ANON_KEY || '';
const USERNAME = (process.env.ADMIN_USERNAME || 'ashu').trim().toLowerCase();
const PASSWORD = process.env.ADMIN_PASSWORD || 'Ashu1501@';
const PATIENT_FORM_BASE = process.env.PATIENT_FORM_URL || 'https://vaitalcare-patient.vercel.app';
const AUTH_DOMAIN = 'auth.vaitalcare.local';

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function sbFetch(endpoint, { token, method = 'GET', body } = {}) {
  const headers = {
    apikey: ANON_KEY,
    Authorization: `Bearer ${token || ANON_KEY}`,
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

async function main() {
  if (!SUPABASE_URL || !ANON_KEY) fail('SUPABASE_URL and SUPABASE_ANON_KEY required in .env');

  console.log('\n── Admin sign-in ──');
  const login = await sbFetch('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: `${USERNAME}@${AUTH_DOMAIN}`, password: PASSWORD },
  });
  if (!login.ok) fail(`Login failed (${login.status}): ${JSON.stringify(login.json)}`);
  const accessToken = login.json?.access_token;
  if (!accessToken) fail('No access token returned');

  const isAdmin = await sbFetch('/rest/v1/rpc/current_user_is_platform_admin', {
    token: accessToken,
    method: 'POST',
    body: {},
  });
  if (!isAdmin.ok || isAdmin.json !== true) fail('User is not a platform admin');

  console.log(`✅ Signed in as ${USERNAME} (platform admin)`);

  console.log('\n── List onboarded clinics ──');
  const clinicsRes = await sbFetch('/rest/v1/rpc/admin_list_clinics', {
    token: accessToken,
    method: 'POST',
    body: {},
  });
  if (!clinicsRes.ok) fail(`admin_list_clinics failed: ${JSON.stringify(clinicsRes.json)}`);
  const clinics = Array.isArray(clinicsRes.json) ? clinicsRes.json : [];
  if (!clinics.length) fail('No onboarded clinics found — submit hospital onboarding first');
  const clinic =
    clinics.find(c => Number(c.doctor_count) > 0 || Number(c.active_token_count) > 0) ||
    clinics[0];
  console.log(`✅ Using clinic: ${clinic.name} (${clinic.code})`);

  console.log('\n── Mint clinic-scoped intake token ──');
  const label = `QR test ${Date.now()}`;
  const tokenRes = await sbFetch('/rest/v1/rpc/create_clinic_intake_token', {
    token: accessToken,
    method: 'POST',
    body: {
      p_clinic_id: clinic.clinic_id,
      p_label: label,
      p_expires_at: null,
    },
  });
  if (!tokenRes.ok) fail(`create_clinic_intake_token failed: ${JSON.stringify(tokenRes.json)}`);
  const row = Array.isArray(tokenRes.json) ? tokenRes.json[0] : tokenRes.json;
  const rawToken = row?.token;
  if (!/^[a-f0-9]{64}$/i.test(rawToken || '')) fail(`Unexpected token format: ${rawToken}`);
  const scanUrl = `${PATIENT_FORM_BASE.replace(/\/+$/, '')}/#/i/${rawToken}`;
  console.log(`✅ Token created (label: ${label})`);
  console.log(`   Scan URL: ${scanUrl}`);

  console.log('\n── Resolve token (anon, like patient form) ──');
  const resolveRes = await sbFetch('/rest/v1/rpc/resolve_public_intake_token', {
    method: 'POST',
    body: { p_token: rawToken },
  });
  if (!resolveRes.ok) fail(`resolve_public_intake_token failed: ${JSON.stringify(resolveRes.json)}`);
  const resolved = Array.isArray(resolveRes.json) ? resolveRes.json[0] : resolveRes.json;
  if (!resolved?.clinic_id) fail(`Token did not resolve to a clinic: ${JSON.stringify(resolveRes.json)}`);
  if (resolved.clinic_id !== clinic.clinic_id) {
    fail(`Clinic mismatch: expected ${clinic.clinic_id}, got ${resolved.clinic_id}`);
  }
  console.log(`✅ Token resolves to clinic_id ${resolved.clinic_id}`);
  console.log(`   hospital_name: ${resolved.hospital_name || '(none)'}`);
  console.log(`   doctor_name: ${resolved.doctor_name || '(none)'}`);

  console.log('\n── List tokens for clinic ──');
  const listRes = await sbFetch('/rest/v1/rpc/admin_list_intake_tokens', {
    token: accessToken,
    method: 'POST',
    body: { p_clinic_id: clinic.clinic_id },
  });
  if (!listRes.ok) fail(`admin_list_intake_tokens failed: ${JSON.stringify(listRes.json)}`);
  const tokens = Array.isArray(listRes.json) ? listRes.json : [];
  const created = tokens.find(t => t.label === label && t.status === 'active');
  if (!created) fail('Newly created token not found in admin_list_intake_tokens');
  console.log(`✅ Token listed (${tokens.length} total for clinic, new token active)`);

  console.log('\n[admin-console-qr-token] All checks passed.\n');
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
