#!/usr/bin/env node
/**
 * Supabase preflight — run before docker / n8n so schema, pooler, and PostgREST stay aligned.
 *
 *   • Validates SUPABASE_URL project ref vs SUPABASE_DB_USER (postgres.<ref> on pooler)
 *   • Warns on db.<ref>.supabase.co (IPv6 / Docker issues) and transaction pooler (6543)
 *   • Applies schemas/preflight-migrations.sql idempotently (Postgres + NOTIFY pgrst)
 *   • Optionally probes REST after a short delay (cache)
 *
 * Env:
 *   SKIP_SUPABASE_PREFLIGHT=1  — exit 0 immediately
 *   PREFLIGHT_REST_VERIFY=0    — skip REST probe (default: verify if keys set)
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

function parseEnv(filePath) {
  try {
    return Object.fromEntries(
      fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
        .map(l => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    );
  } catch {
    return {};
  }
}

function extractProjectRef(supabaseUrl) {
  try {
    const u = new URL(supabaseUrl.trim());
    const m = u.hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Prefer full URI from Supabase Dashboard → Connect (overrides discrete SUPABASE_DB_*). */
function getDbConfig(env) {
  const raw = (env.SUPABASE_DATABASE_URL || env.DATABASE_URL || env.SUPABASE_DB_URL || '').trim();
  if (raw && /^postgres(ql)?:\/\//i.test(raw)) {
    let u;
    try {
      u = new URL(raw.replace(/^postgresql:/i, 'postgres:'));
    } catch {
      die('Invalid SUPABASE_DATABASE_URL / DATABASE_URL');
    }
    const db = (u.pathname || '/postgres').replace(/^\//, '') || 'postgres';
    return {
      fromUrl : true,
      host    : u.hostname,
      port    : parseInt(u.port || '5432', 10),
      user    : decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: db,
    };
  }
  return {
    fromUrl : false,
    host    : env.SUPABASE_DB_HOST,
    port    : parseInt(env.SUPABASE_DB_PORT || '5432', 10),
    user    : env.SUPABASE_DB_USER,
    password: env.SUPABASE_DB_PASSWORD,
    database: env.SUPABASE_DB_NAME || 'postgres',
  };
}

function isDirectDbHost(host) {
  return /^db\.[a-z0-9]+\.supabase\.co$/i.test(host || '');
}

function isPoolerHost(host) {
  return (host || '').includes('pooler.supabase.com');
}

/**
 * Split SQL on semicolons outside quotes and dollar-quoted blocks.
 */
function splitSqlStatements(content) {
  const statements = [];
  let buf = '';
  let i = 0;

  while (i < content.length) {
    if (content[i] === '-' && content[i + 1] === '-') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (content[i] === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < content.length - 1 && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    const c = content[i];

    if (c === "'") {
      buf += c;
      i++;
      while (i < content.length) {
        if (content[i] === "'") {
          if (content[i + 1] === "'") {
            buf += "''";
            i += 2;
            continue;
          }
          buf += "'";
          i++;
          break;
        }
        buf += content[i++];
      }
      continue;
    }

    if (c === '$') {
      const m = content.slice(i).match(/^\$([a-zA-Z_0-9]*)\$/);
      if (!m) {
        buf += c;
        i++;
        continue;
      }
      const tag = m[0];
      buf += tag;
      i += tag.length;
      while (i < content.length) {
        if (content.slice(i, i + tag.length) === tag) {
          buf += tag;
          i += tag.length;
          break;
        }
        buf += content[i++];
      }
      continue;
    }

    if (c === ';') {
      const s = buf.trim();
      if (s.length) statements.push(s);
      buf = '';
      i++;
      continue;
    }

    buf += c;
    i++;
  }
  const tail = buf.trim();
  if (tail.length) statements.push(tail);
  return statements;
}

function die(msg) {
  console.error(`[preflight] ❌ ${msg}`);
  process.exit(1);
}

function warn(msg) {
  console.warn(`[preflight] ⚠️  ${msg}`);
}

function ok(msg) {
  console.log(`[preflight] ✅ ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  if (process.env.SKIP_SUPABASE_PREFLIGHT === '1') {
    console.log('[preflight] SKIP_SUPABASE_PREFLIGHT=1 — skipping.');
    return;
  }

  const repoRoot = path.join(__dirname, '..');
  const envPath  = path.join(repoRoot, '.env');
  const env      = parseEnv(envPath);

  if (!env.SUPABASE_URL || env.SUPABASE_URL.includes('YOUR_')) {
    die('Missing or placeholder SUPABASE_URL in .env');
  }

  const dbCfg = getDbConfig(env);
  if (!dbCfg.fromUrl) {
    const discrete = ['SUPABASE_DB_HOST', 'SUPABASE_DB_USER', 'SUPABASE_DB_PASSWORD', 'SUPABASE_DB_NAME'];
    for (const k of discrete) {
      if (!env[k] || (typeof env[k] === 'string' && env[k].includes('YOUR_'))) {
        die(`Missing or placeholder ${k} in .env — or set SUPABASE_DATABASE_URL with the URI from Supabase Connect.`);
      }
    }
  }

  const ref = extractProjectRef(env.SUPABASE_URL);
  if (!ref) warn('Could not parse project ref from SUPABASE_URL (expected https://<ref>.supabase.co)');

  const host = dbCfg.host;
  const port = dbCfg.port;
  const user = dbCfg.user;

  if (dbCfg.fromUrl) {
    ok('Using SUPABASE_DATABASE_URL / DATABASE_URL for Postgres connection.');
  }

  if (isDirectDbHost(host)) {
    warn('Host is db.<project>.supabase.co — often unreachable from Docker Desktop (IPv6).');
    warn('Prefer Session pooler URI from Supabase → Connect (pooler.supabase.com, port 5432).');
  }

  if (isPoolerHost(host)) {
    if (ref && user === 'postgres') {
      warn(`On pooler, user is usually postgres.${ref} (not "postgres").`);
    } else if (ref && user && user !== `postgres.${ref}` && /^postgres/.test(user)) {
      warn(`Expected user postgres.${ref} for this project (got "${user}").`);
    } else if (ref && user === `postgres.${ref}`) {
      ok(`Pooler user matches project ref (${user}).`);
    }
    if (port === 6543) {
      warn('Port 6543 = transaction pooler; n8n Postgres nodes usually need session mode (port 5432).');
    }
  }

  const sqlFile = path.join(repoRoot, 'schemas', 'preflight-migrations.sql');
  if (!fs.existsSync(sqlFile)) die(`Missing ${sqlFile}`);

  const sqlRaw = fs.readFileSync(sqlFile, 'utf8');
  const chunks = splitSqlStatements(sqlRaw).filter(s => {
    const t = s.trim();
    return t.length > 0 && !t.startsWith('--');
  });

  const client = new Client({
    host                 : host,
    port,
    user,
    password             : dbCfg.password,
    database             : dbCfg.database,
    ssl                  : { rejectUnauthorized: false },
    connectionTimeoutMillis: 25000,
  });

  try {
    await client.connect();
  } catch (e) {
    const msg = e.message || String(e);
    console.error('[preflight] Connection error:', msg);
    if (/Tenant or user not found|password authentication failed/i.test(msg)) {
      warn('Pooler auth failed: use Database password from Supabase, user postgres.<project-ref>, session pooler host + port 5432.');
    }
    die('Could not connect to Postgres — fix SUPABASE_DB_* in .env (see messages above).');
  }

  ok('Connected to Postgres.');

  let n = 0;
  await client.query('BEGIN');
  try {
    for (const stmt of chunks) {
      try {
        await client.query(stmt);
        n++;
      } catch (e) {
        console.error('[preflight] Statement failed:\n', stmt.slice(0, 200) + (stmt.length > 200 ? '…' : ''));
        throw e;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    die(e.message || String(e));
  }

  await client.end();
  ok(`Applied ${n} SQL statement(s). PostgREST reload signaled (NOTIFY pgrst).`);

  const skipRest = process.env.PREFLIGHT_REST_VERIFY === '0' || !env.SUPABASE_SERVICE_ROLE_KEY;
  if (!skipRest) {
    await sleep(1500);
    const tables = ['patients', 'hospital_boarding', 'system_logs'];
    for (const t of tables) {
      const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${t}?select=id&limit=1`, {
        headers: {
          apikey       : env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (!r.ok) {
        const txt = await r.text();
        warn(`REST ${t}: HTTP ${r.status} ${txt.slice(0, 160)} — if PGRST205, wait ~60s or Dashboard → API → Reload schema.`);
      } else {
        ok(`REST API sees ${t}.`);
      }
    }
  }
}

main().catch(e => {
  console.error('[preflight] ❌', e);
  process.exit(1);
});
