#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const repoRoot = path.join(__dirname, '..');
const AUTH_USERNAME_EMAIL_DOMAIN = 'auth.vaitalcare.local';

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

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=');
    out[rawKey] = inlineValue ?? argv[i + 1];
    if (inlineValue === undefined) i += 1;
  }
  return out;
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function usernameToInternalEmail(username) {
  return `${normalizeUsername(username)}@${AUTH_USERNAME_EMAIL_DOMAIN}`;
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

async function findUserIdByEmail(env, email) {
  const cfg = getDbConfig(env);
  if (!cfg.host || !cfg.user || !cfg.password) return '';
  const client = new Client({ ...cfg, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const res = await client.query('select id::text from auth.users where lower(email) = lower($1) limit 1', [email]);
    return res.rows[0]?.id || '';
  } finally {
    await client.end().catch(() => {});
  }
}

async function supabaseFetch(env, endpoint, options = {}) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${base}${endpoint}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const detail = json?.msg || json?.message || json?.error_description || json?.error || text || `HTTP ${res.status}`;
    const err = new Error(detail);
    err.status = res.status;
    err.body = json || text;
    throw err;
  }
  return json;
}

async function createAuthUser(env, email, password, label) {
  return supabaseFetch(env, '/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { label, role: 'platform_admin' },
    }),
  });
}

async function upsertPlatformAdmin(env, userId, label) {
  return supabaseFetch(env, '/rest/v1/platform_admins?on_conflict=user_id', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({ user_id: userId, label }),
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...parseEnv(path.join(repoRoot, '.env')), ...process.env };

  const username = normalizeUsername(args.username || env.PLATFORM_ADMIN_USERNAME || '');
  const email = String(args.email || env.PLATFORM_ADMIN_EMAIL || (username ? usernameToInternalEmail(username) : '')).trim().toLowerCase();
  const password = String(args.password || env.PLATFORM_ADMIN_PASSWORD || '');
  const label = String(args.label || env.PLATFORM_ADMIN_LABEL || username || email || 'Platform admin').trim();
  let userId = String(args['user-id'] || env.PLATFORM_ADMIN_USER_ID || '').trim();

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }
  if (!userId && !email) {
    throw new Error('Provide --username, --email, or PLATFORM_ADMIN_USER_ID.');
  }

  if (!userId) {
    if (!password || password.length < 8) {
      throw new Error('Provide --password or PLATFORM_ADMIN_PASSWORD with at least 8 characters when creating an auth user.');
    }
    try {
      const created = await createAuthUser(env, email, password, label);
      userId = created?.user?.id || created?.id || '';
      console.log(`[bootstrap-platform-admin] Created auth user ${email}.`);
    } catch (err) {
      if (!/already|registered|exists|duplicate/i.test(err.message)) throw err;
      userId = await findUserIdByEmail(env, email);
      if (!userId) {
        throw new Error(
          `Auth user ${email} already exists, but its UUID could not be resolved. ` +
          'Set PLATFORM_ADMIN_USER_ID or configure SUPABASE_DB_* so the script can look it up.',
        );
      }
      console.log(`[bootstrap-platform-admin] Reusing existing auth user ${email}.`);
    }
  }

  await upsertPlatformAdmin(env, userId, label);
  console.log(`[bootstrap-platform-admin] Granted platform admin to ${userId} (${label}).`);
  if (username) {
    console.log(`[bootstrap-platform-admin] Admin console login username: ${username}`);
  } else {
    console.log(`[bootstrap-platform-admin] Admin console login email: ${email}`);
  }
}

main().catch(err => {
  console.error(`[bootstrap-platform-admin] ${err.message}`);
  process.exit(1);
});
