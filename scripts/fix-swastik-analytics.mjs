#!/usr/bin/env node
/**
 * Diagnose why Swastik Hospital doctor analytics is empty, then re-seed demo data.
 *
 *   npm run fix:swastik-analytics
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const HOSPITAL_NAME = process.env.SWASTIK_HOSPITAL || 'Swastik Hospital';
const AUTH_DOMAIN = 'auth.vaitalcare.local';
const DOCTORS = [
  { username: 'swastik.vikram', password: 'Swastik123' },
  { username: 'swastik.ananya', password: 'Swastik123' },
];

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
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON_KEY = env.SUPABASE_ANON_KEY || '';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(isoDate, offset) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function sbFetch(endpoint, { method = 'GET', body } = {}) {
  const res = await fetch(`${SUPABASE_URL}${endpoint}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { ok: res.ok, status: res.status, json, headers: res.headers };
}

async function countRows(table, filter) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}&select=id`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: 'count=exact',
    },
  });
  const range = res.headers.get('content-range') || '0';
  return Number(range.split('/')[1] || 0);
}

async function doctorLogin(username, password) {
  const email = `${String(username).trim().toLowerCase()}@${AUTH_DOMAIN}`;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  return {
    ok: res.ok,
    accessToken: body.access_token || null,
    userId: body.user?.id || null,
    error: body.error_description || body.msg || body.message || null,
  };
}

async function testAnalyticsRpc(accessToken, clinicId, doctorProfileId = null) {
  const fromDate = addDaysISO(todayISO(), -179);
  const toDate = todayISO();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/doctor_get_analytics_overview`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_clinic_id: clinicId,
      p_from_date: fromDate,
      p_to_date: toDate,
      p_doctor_profile_id: doctorProfileId,
      p_patient_type: 'all',
      p_include_demo: false,
    }),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function diagnose() {
  console.log('\n── Swastik analytics diagnosis ──\n');

  const boardingRes = await sbFetch(
    `/rest/v1/hospital_boarding?hospital_name=eq.${encodeURIComponent(HOSPITAL_NAME)}&select=clinic_id,doctor_name,auth_user_id,login_username&order=created_at.asc`,
  );
  const boarding = Array.isArray(boardingRes.json) ? boardingRes.json : [];
  if (!boarding.length) {
    console.log('❌ Root cause: Swastik Hospital is not onboarded (no hospital_boarding rows).');
    return { clinicId: null, issues: ['not_onboarded'] };
  }

  const clinicId = boarding[0].clinic_id;
  const issues = [];

  const visitTotal = await countRows('patient_visits', `clinic_id=eq.${clinicId}`);
  const visitsNoDoctor = await countRows('patient_visits', `clinic_id=eq.${clinicId}&doctor_profile_id=is.null`);
  const membershipTotal = await countRows('clinic_memberships', `clinic_id=eq.${clinicId}&status=eq.active`);
  const profilesRes = await sbFetch(
    `/rest/v1/doctor_profiles?clinic_id=eq.${clinicId}&select=id,doctor_name,login_username,user_id,is_clinic_admin`,
  );
  const profiles = Array.isArray(profilesRes.json) ? profilesRes.json : [];

  console.log(`Clinic ID: ${clinicId}`);
  console.log(`Visits: ${visitTotal} (${visitsNoDoctor} missing doctor_profile_id)`);
  console.log(`Doctor profiles: ${profiles.length}`);
  console.log(`Active clinic_memberships: ${membershipTotal}`);
  console.log('');

  if (visitTotal < 30) {
    issues.push('insufficient_visit_history');
    console.log('❌ Root cause: Almost no visit history — only today\'s queue was seeded.');
    console.log('   Fix: run full demo seed (12 months of visits).');
  }

  if (membershipTotal === 0) {
    issues.push('missing_memberships');
    console.log('❌ Root cause: No clinic_memberships — analytics RPCs return "not authorized".');
    console.log('   Fix: backfill memberships for each doctor auth user.');
  }

  if (visitsNoDoctor > 0 && profiles.length > 0) {
    issues.push('visits_missing_doctor_profile');
    console.log(`❌ Root cause: ${visitsNoDoctor} visits lack doctor_profile_id.`);
    console.log('   Non-admin doctors (e.g. swastik.ananya) see an empty dashboard when filtered.');
  }

  const boardingNoAuth = boarding.filter(b => !b.auth_user_id);
  if (boardingNoAuth.length) {
    issues.push('boarding_missing_auth');
    console.log(`❌ Root cause: ${boardingNoAuth.length} boarding row(s) have no auth_user_id — doctors cannot sign in.`);
  }

  const profilesNoUser = profiles.filter(p => !p.user_id);
  if (profilesNoUser.length) {
    issues.push('profiles_not_linked');
    console.log(`⚠️  ${profilesNoUser.length} doctor profile(s) not linked to auth users.`);
  }

  if (!ANON_KEY) {
    console.log('⚠️  SUPABASE_ANON_KEY missing — skipping live RPC test.');
  } else {
    console.log('── Live analytics RPC test (as each doctor) ──\n');
    for (const doc of DOCTORS) {
      const login = await doctorLogin(doc.username, doc.password);
      if (!login.ok) {
        issues.push(`auth_failed_${doc.username}`);
        console.log(`❌ ${doc.username}: login failed — ${login.error}`);
        continue;
      }

      const profile = profiles.find(p => p.login_username === doc.username);
      const rpc = await testAnalyticsRpc(
        login.accessToken,
        clinicId,
        profile?.is_clinic_admin ? null : profile?.id || null,
      );

      if (!rpc.ok) {
        issues.push(`rpc_failed_${doc.username}`);
        const msg = typeof rpc.json === 'object' ? (rpc.json.message || rpc.json.error || JSON.stringify(rpc.json)) : rpc.json;
        console.log(`❌ ${doc.username}: analytics RPC failed (${rpc.status}) — ${msg}`);
        continue;
      }

      const patients = rpc.json?.patients || {};
      const periodVisits = Number(rpc.json?.new_vs_returning?.new || 0) + Number(rpc.json?.new_vs_returning?.returning || 0);
      console.log(`✅ ${doc.username}: today=${patients.today ?? 0}, period visits=${periodVisits}, retention=${rpc.json?.retention_rate ?? 0}%`);

      if (periodVisits === 0 && visitTotal > 0) {
        issues.push(`empty_for_${doc.username}`);
        console.log(`   ⚠️  Dashboard empty for this doctor — likely doctor_profile_id filter mismatch.`);
      }
    }
  }

  if (!issues.length) {
    console.log('\n✅ Data and access look healthy. If UI is still empty, redeploy doctor-analytics or hard-refresh.');
  } else {
    console.log(`\nFound ${issues.length} issue(s) — re-seeding now…`);
  }

  return { clinicId, issues, visitTotal, membershipTotal, profiles };
}

function runSeed() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'node',
      [path.join(__dirname, 'seed-swastik-hospital.mjs')],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          SWASTIK_FULL_DEMO: '1',
          SWASTIK_SKIP_ROLLUP: '1',
        },
      },
    );
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`seed exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env');
    process.exit(1);
  }

  await diagnose();

  console.log('\n── Re-seeding Swastik full demo (12 months, skip slow rollup) ──\n');
  await runSeed();

  console.log('\n── Post-fix verification ──\n');
  const after = await diagnose();

  if (after.visitTotal >= 30 && after.membershipTotal > 0) {
    console.log('\n✅ Swastik analytics should now show data at:');
    console.log('   https://vaitalcare-doctor-analytics.vercel.app');
    console.log('   Login: swastik.vikram / Swastik123 → select "Last 6 months"\n');
  }
}

main().catch(err => {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
});
