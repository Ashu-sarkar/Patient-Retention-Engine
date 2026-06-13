#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

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
        })
    );
  } catch {
    return {};
  }
}

function getDbConfig(env) {
  const raw = (env.SUPABASE_DATABASE_URL || env.DATABASE_URL || env.SUPABASE_DB_URL || '').trim();
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

async function main() {
  const env = { ...parseEnv(path.join(repoRoot, '.env')), ...process.env };
  const db = getDbConfig(env);
  const missing = ['host', 'user', 'password', 'database'].filter(key => !db[key]);
  if (missing.length) {
    console.error(`[tenant-isolation] Missing DB config: ${missing.join(', ')}`);
    process.exit(1);
  }

  const client = new Client({
    ...db,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 25000,
  });

  await client.connect();
  const checks = [
    ['patients_missing_clinic', "SELECT COUNT(*)::int AS count FROM public.patients WHERE clinic_id IS NULL"],
    ['visits_missing_clinic', "SELECT COUNT(*)::int AS count FROM public.patient_visits WHERE clinic_id IS NULL"],
    ['visits_patient_clinic_mismatch', "SELECT COUNT(*)::int AS count FROM public.patient_visits pv JOIN public.patients p ON p.id = pv.patient_id WHERE pv.clinic_id <> p.clinic_id"],
    ['prescriptions_patient_clinic_mismatch', "SELECT COUNT(*)::int AS count FROM public.prescriptions pr JOIN public.patients p ON p.id = pr.patient_id WHERE pr.clinic_id <> p.clinic_id"],
    ['message_logs_missing_clinic', "SELECT COUNT(*)::int AS count FROM public.message_logs WHERE clinic_id IS NULL"],
    ['message_ledger_missing_clinic', "SELECT COUNT(*)::int AS count FROM public.message_ledger WHERE clinic_id IS NULL"],
    ['global_patient_phone_duplicates', "SELECT COUNT(*)::int AS count FROM (SELECT phone FROM public.patients GROUP BY phone HAVING COUNT(*) > 1) d"],
    ['clinic_patient_phone_duplicates', "SELECT COUNT(*)::int AS count FROM (SELECT clinic_id, phone FROM public.patients GROUP BY clinic_id, phone HAVING COUNT(*) > 1) d"],
  ];

  let failed = false;
  for (const [name, sql] of checks) {
    const result = await client.query(sql);
    const count = Number(result.rows[0]?.count || 0);
    const ok = name === 'global_patient_phone_duplicates' ? true : count === 0;
    console.log(`${ok ? 'OK' : 'FAIL'} ${name}: ${count}`);
    if (!ok) failed = true;
  }

  await client.end();
  if (failed) {
    console.error('[tenant-isolation] Tenant isolation validation failed.');
    process.exit(1);
  }
  console.log('[tenant-isolation] Tenant isolation validation passed.');
}

main().catch(error => {
  console.error('[tenant-isolation] Failed:', error.message || error);
  process.exit(1);
});
