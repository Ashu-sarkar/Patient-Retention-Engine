#!/usr/bin/env node
'use strict';

/**
 * Diagnose doctor dashboard login issues.
 * Usage: node scripts/doctor-login-diagnose.mjs [username] [password]
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const root = path.join(__dirname, '..');

function parseEnv(filePath) {
  try {
    return Object.fromEntries(
      fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

const env = { ...parseEnv(path.join(root, '.env')), ...process.env };
const SUPABASE_URL = (env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY = env.SUPABASE_ANON_KEY || '';
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
const AUTH_DOMAIN = 'auth.vaitalcare.local';

function getDbConfig() {
  const raw = (env.SUPABASE_DATABASE_URL || env.DATABASE_URL || '').trim();
  if (raw && /^postgres(ql)?:\/\//i.test(raw)) {
    const u = new URL(raw.replace(/^postgresql:/i, 'postgres:'));
    return {
      host: u.hostname,
      port: parseInt(u.port || '5432', 10),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: (u.pathname || '/postgres').replace(/^\//, '') || 'postgres',
    };
  }
  return {
    host: env.SUPABASE_DB_HOST,
    port: parseInt(env.SUPABASE_DB_PORT || '5432', 10),
    user: env.SUPABASE_DB_USER,
    password: env.SUPABASE_DB_PASSWORD,
    database: env.SUPABASE_DB_NAME || 'postgres',
  };
}

async function tryPasswordLogin(username, password) {
  const email = `${String(username).trim().toLowerCase()}@${AUTH_DOMAIN}`;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  return {
    ok: res.ok,
    status: res.status,
    email,
    message: body.error_description || body.msg || body.message || body.error || null,
    userId: body.user?.id || null,
  };
}

async function listDoctorUsernames(client) {
  const { rows } = await client.query(`
    SELECT dp.login_username, dp.doctor_name, dp.clinic_name, dp.user_id IS NOT NULL AS linked
    FROM public.doctor_profiles dp
    WHERE dp.login_username IS NOT NULL
    ORDER BY dp.updated_at DESC NULLS LAST
    LIMIT 20
  `);
  if (rows.length) return rows;

  const boarding = await client.query(`
    SELECT login_username, doctor_name, hospital_name AS clinic_name, auth_user_id IS NOT NULL AS linked
    FROM public.hospital_boarding
    WHERE login_username IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 20
  `);
  return boarding.rows;
}

async function main() {
  console.log('\nDoctor Dashboard — Login Diagnostic\n');

  if (!SUPABASE_URL || !ANON_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
    process.exit(1);
  }

  const cfg = getDbConfig();
  if (!cfg.host || !cfg.user || !cfg.password) {
    console.error('Missing database credentials in .env');
    process.exit(1);
  }

  const client = new Client({ ...cfg, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const doctors = await listDoctorUsernames(client);
    console.log('Known dashboard usernames in DB:');
    if (!doctors.length) {
      console.log('  (none) — run: npm run seed:demo-clinic');
    } else {
      for (const d of doctors) {
        console.log(`  • ${d.login_username} — ${d.doctor_name} @ ${d.clinic_name} ${d.linked ? '[auth linked]' : '[NO auth user]'}`);
      }
    }

    const testUser = process.argv[2];
    const testPass = process.argv[3];

    if (testUser && testPass) {
      console.log(`\nTesting login for username "${testUser}"...`);
      const result = await tryPasswordLogin(testUser, testPass);
      if (result.ok) {
        console.log(`  ✅ Auth OK (user id ${result.userId})`);
        const { rows } = await client.query(
          `SELECT public.get_or_create_doctor_profile_for_current_user() AS ignored`,
        ).catch(() => ({ rows: [] }));
        void rows;
        // Profile RPC needs JWT — test via service role impersonation instead
        const profile = await client.query(
          `SELECT id, clinic_id, doctor_name FROM public.doctor_profiles WHERE user_id = $1::uuid LIMIT 1`,
          [result.userId],
        );
        if (profile.rows[0]) {
          console.log(`  ✅ Doctor profile linked: ${profile.rows[0].doctor_name}`);
        } else {
          console.log('  ⚠️  Auth succeeded but no doctor_profiles row for this user.');
          console.log('     Run npm run preflight, then sign in again (RPC should bootstrap profile).');
        }
      } else {
        console.log(`  ❌ Auth failed (${result.status}): ${result.message}`);
        if (/invalid/i.test(String(result.message))) {
          console.log('\nFix options:');
          console.log('  1. Reset password in Supabase → Authentication → Users');
          console.log('  2. Re-create demo doctors: npm run seed:demo-clinic');
        }
      }
    } else {
      console.log('\nTo test credentials:');
      console.log('  node scripts/doctor-login-diagnose.mjs demo.priya.nair DemoPass123');
    }

    console.log('\nLogin tips:');
    console.log('  • Use USERNAME only (not email) — e.g. demo.priya.nair');
    console.log('  • Password is case-sensitive, min 8 chars');
    console.log('  • Local preview without Supabase: ?demo=1 on doctor-dashboard URL');
    console.log('  • Demo seed passwords (if seeded): DemoPass123\n');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Diagnostic failed:', err.message);
  process.exit(1);
});
