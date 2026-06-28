#!/usr/bin/env node
'use strict';

/**
 * Refresh clinic_daily_analytics rollups for yesterday (Phase 2 nightly job entrypoint).
 *
 * Usage:
 *   node scripts/refresh-clinic-analytics-rollup.js
 *   METRIC_DATE=2026-06-01 node scripts/refresh-clinic-analytics-rollup.js
 *
 * Schedule via n8n cron or GitHub Actions calling this script with service-role DB access.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

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

const env = { ...parseEnv(path.join(__dirname, '..', '.env')), ...process.env };

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

async function main() {
  const cfg = getDbConfig();
  if (!cfg.host || !cfg.user || !cfg.password) {
    console.error('[rollup] Missing SUPABASE_DATABASE_URL or SUPABASE_DB_* in .env');
    process.exit(1);
  }

  const metricDate = env.METRIC_DATE || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const client = new Client({ ...cfg, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('SELECT public.refresh_clinic_daily_analytics($1::date)', [metricDate]);
    console.log(`[rollup] Refreshed clinic_daily_analytics for ${metricDate}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[rollup] Failed:', err.message || err);
  process.exit(1);
});
