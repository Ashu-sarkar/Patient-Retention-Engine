#!/usr/bin/env node
/**
 * Patient Retention Engine — n8n Setup Script  (n8n 2.x compatible)
 *
 * Idempotent — safe to run on every deployment or after volume wipe.
 *
 * What it does (in order):
 *  1. Waits for n8n /healthz to be reachable
 *  2. Creates the owner account on first boot (showSetupOnFirstLoad = true)
 *  3. Logs in with session cookie (N8N_SECURE_COOKIE=false required for HTTP)
 *  4. Creates/upserts Supabase DB + WhatsApp credentials
 *  5. Patches placeholder credential IDs in every workflow
 *  6. Activates all workflows (WF1–WF8, WF11, WF12)
 *
 * Usage:
 *   node tests/setup-n8n.js
 *
 * Environment (read from .env):
 *   N8N_HOST, N8N_PORT, N8N_OWNER_EMAIL, N8N_OWNER_PASSWORD
 *   SUPABASE_DB_HOST, SUPABASE_DB_PORT, SUPABASE_DB_NAME,
 *   SUPABASE_DB_USER, SUPABASE_DB_PASSWORD
 *   WA_ACCESS_TOKEN  (optional — placeholder used if absent)
 *
 * Run `npm run preflight` or `./launch.sh` first so Postgres columns match workflows
 * and PostgREST cache is reloaded (avoids name / workflow_name / hospital_boarding drift).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Parse .env ────────────────────────────────────────────────────────────────
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
  } catch { return {}; }
}

const env    = parseEnv(path.join(__dirname, '..', '.env'));
const HOST   = env.N8N_HOST     || 'localhost';
const PORT   = env.N8N_PORT     || '5678';
const BASE   = `http://${HOST}:${PORT}`;
const WF_DIR = path.join(__dirname, '..', 'workflows');

// Owner credentials — prefer explicit env vars, fall back to n8n auth vars
const OWNER_EMAIL     = env.N8N_OWNER_EMAIL    || 'sarkar.ashu15@gmail.com';
const OWNER_PASSWORD  = env.N8N_OWNER_PASSWORD || 'Ashu1501@';
const OWNER_FIRSTNAME = env.N8N_OWNER_FIRSTNAME || 'Ashutosh';
const OWNER_LASTNAME  = env.N8N_OWNER_LASTNAME  || 'Sarkar';

// ── HTTP helpers ──────────────────────────────────────────────────────────────
let sessionCookie = '';

async function request(method, endpoint, body, extraHeaders = {}) {
  const url  = `${BASE}${endpoint}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      ...extraHeaders,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { ok: res.ok, status: res.status, json, headers: res.headers };
}

// ── Wait for n8n to be healthy ────────────────────────────────────────────────
async function waitForN8n(maxSeconds = 90) {
  console.log(`  Waiting for n8n at ${BASE}/healthz …`);
  for (let i = 0; i < maxSeconds; i += 3) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok || r.status === 401) { console.log(`  ✅ n8n is up`); return; }
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 3000));
    process.stdout.write('.');
  }
  throw new Error(`n8n did not become healthy within ${maxSeconds}s`);
}

// ── Owner setup (first boot only) ─────────────────────────────────────────────
async function ensureOwner() {
  const { json } = await request('GET', '/rest/settings');
  const needsSetup = json?.data?.userManagement?.showSetupOnFirstLoad;
  if (!needsSetup) {
    console.log('  Owner already configured — skipping setup.');
    return;
  }
  console.log('  First boot detected — creating owner account…');
  const { ok, json: r } = await request('POST', '/rest/owner/setup', {
    email:       OWNER_EMAIL,
    password:    OWNER_PASSWORD,
    firstName:   OWNER_FIRSTNAME,
    lastName:    OWNER_LASTNAME,
    skipSurvey:  true,
  });
  if (ok) {
    console.log(`  ✅ Owner created: ${r?.data?.email}`);
  } else {
    // May already exist from a previous partial run
    console.log(`  ⏭  Owner setup response: ${JSON.stringify(r).slice(0, 120)}`);
  }
}

// ── Login + capture session cookie ───────────────────────────────────────────
async function login() {
  const { ok, json, headers } = await request('POST', '/rest/login', {
    emailOrLdapLoginId: OWNER_EMAIL,
    password:           OWNER_PASSWORD,
  });
  if (!ok) throw new Error(`Login failed: ${JSON.stringify(json).slice(0, 200)}`);

  // Capture the n8n-auth cookie from Set-Cookie header
  const setCookie = headers.get('set-cookie') || '';
  const match = setCookie.match(/n8n-auth=([^;]+)/);
  if (!match) throw new Error('Login succeeded but no n8n-auth cookie found in response');
  sessionCookie = `n8n-auth=${match[1]}`;
  console.log(`  ✅ Logged in as ${json?.data?.email}`);
}

// ── Credential helpers ────────────────────────────────────────────────────────
async function listCredentials() {
  const { json } = await request('GET', '/rest/credentials');
  return json?.data || [];
}

async function upsertCredential(name, type, data) {
  const existing = (await listCredentials()).find(c => c.name === name);
  if (existing) {
    // PATCH requires name + type to pass schema validation
    const { ok, json } = await request('PATCH', `/rest/credentials/${existing.id}`, { name, type, data });
    if (!ok) console.warn(`  ⚠️  Could not update "${name}": ${JSON.stringify(json).slice(0, 120)}`);
    else console.log(`  ⏭  Credential "${name}" updated (id: ${existing.id})`);
    return existing.id;
  }
  const { ok, json } = await request('POST', '/rest/credentials', { name, type, data });
  if (!ok) {
    console.warn(`  ⚠️  Could not create "${name}": ${JSON.stringify(json).slice(0, 120)}`);
    return null;
  }
  console.log(`  ✅ Created credential "${name}" (id: ${json?.data?.id ?? json?.id})`);
  return json?.data?.id ?? json?.id;
}

// ── Workflow helpers ──────────────────────────────────────────────────────────
async function listWorkflows() {
  const { json } = await request('GET', '/rest/workflows');
  return json?.data || [];
}

/**
 * Upsert a workflow:
 *  - If a workflow with same id/name exists → PATCH nodes+connections
 *  - Otherwise → POST to create
 */
async function upsertWorkflow(wfJson, credMap) {
  const patched = patchCredentials(wfJson, credMap);
  const all     = await listWorkflows();
  const found   = all.find(w => w.id === patched.id || w.name === patched.name);

  if (found) {
    const merged = { ...found, nodes: patched.nodes, connections: patched.connections };
    const { ok, json } = await request('PATCH', `/rest/workflows/${found.id}`, merged);
    if (!ok) {
      console.warn(`  ⚠️  Update "${patched.name}": ${JSON.stringify(json).slice(0, 120)}`);
      return found.id;
    }
    return found.id;
  }

  const { ok, json } = await request('POST', '/rest/workflows', patched);
  if (!ok) {
    console.warn(`  ⚠️  Create "${patched.name}": ${JSON.stringify(json).slice(0, 120)}`);
    return null;
  }
  return json?.data?.id ?? json?.id;
}

/** Replace REPLACE_* placeholder credential IDs with real IDs */
function patchCredentials(wfJson, credMap) {
  const clone = JSON.parse(JSON.stringify(wfJson));
  for (const node of clone.nodes || []) {
    for (const [ctype, cval] of Object.entries(node.credentials || {})) {
      const cname = cval.name || '';
      const cid   = cval.id   || '';
      // Patch if placeholder or blank
      if ((cid === '' || cid.startsWith('REPLACE') || cid.length < 5) && credMap[cname]) {
        node.credentials[ctype].id = credMap[cname];
      }
    }
    // Downgrade any postgres v2.5 → v2.4 (guard for future JSON additions)
    if (node.type === 'n8n-nodes-base.postgres' && (node.typeVersion ?? 0) >= 2.5) {
      node.typeVersion = 2.4;
    }
  }
  // Replace expression-based timezone with literal
  if (clone.settings?.timezone && clone.settings.timezone.includes('=')) {
    clone.settings.timezone = env.TIMEZONE || 'Asia/Kolkata';
  }
  return clone;
}

async function activateWorkflow(wfId) {
  // Ensure the active version matches the latest edited workflow version.
  const { json } = await request('GET', `/rest/workflows/${wfId}`);
  const wf = json?.data || {};
  const latestVersionId = wf.versionId || '';
  const activeVersionId = wf.activeVersionId || '';
  const isActive = !!wf.active;

  if (!latestVersionId) return { active: false, status: 0, skipped: false, reactivated: false };

  if (isActive && activeVersionId === latestVersionId) {
    return { active: true, status: 200, skipped: true, reactivated: false };
  }

  let reactivated = false;
  if (isActive && activeVersionId !== latestVersionId) {
    const { ok: deactivated } = await request('POST', `/rest/workflows/${wfId}/deactivate`);
    if (!deactivated) {
      return { active: false, status: 500, skipped: false, reactivated: false };
    }
    reactivated = true;
  }

  const { ok, json: r, status } = await request('POST', `/rest/workflows/${wfId}/activate`, { versionId: latestVersionId });
  return { active: r?.data?.active ?? ok ?? false, status, skipped: false, reactivated };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║     Patient Retention Engine — n8n Setup (v2.x)          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Target: ${BASE}\n`);

  // 1. Health check
  console.log('── 1. Connectivity ─────────────────────────────────────────');
  await waitForN8n();

  // 2. Owner setup (first boot)
  console.log('\n── 2. Owner account ────────────────────────────────────────');
  await ensureOwner();

  // 3. Login
  console.log('\n── 3. Login ────────────────────────────────────────────────');
  await login();

  // 4. Credentials
  console.log('\n── 4. Credentials ──────────────────────────────────────────');

  const pgData = {
    host:                 env.SUPABASE_DB_HOST     || '',
    port:                 parseInt(env.SUPABASE_DB_PORT || '5432'),
    database:             env.SUPABASE_DB_NAME     || 'postgres',
    user:                 env.SUPABASE_DB_USER     || 'postgres',
    password:             env.SUPABASE_DB_PASSWORD || '',
    ssl:                  'require',
    // Supabase pooler uses an AWS intermediate CA; allow it without rejecting
    allowUnauthorizedCerts: true,
    sshTunnel:            false,
  };

  const pgId  = await upsertCredential('Supabase DB',          'postgres',       pgData);
  const pgId2 = await upsertCredential('Supabase (Postgres)',  'postgres',       pgData);
  const waToken = env.WA_ACCESS_TOKEN && !env.WA_ACCESS_TOKEN.includes('YOUR_')
    ? env.WA_ACCESS_TOKEN
    : 'PLACEHOLDER_WA_TOKEN';
  const waId  = await upsertCredential('WhatsApp Business API','httpHeaderAuth', {
    name:  'Authorization',
    value: `Bearer ${waToken}`,
  });

  const credMap = {
    'Supabase DB':           pgId,
    'Supabase (Postgres)':   pgId2,
    'WhatsApp Business API': waId,
  };
  console.log(`  Credential map: ${JSON.stringify(credMap)}`);

  // 5. Import / patch workflows
  console.log('\n── 5. Workflow upsert ──────────────────────────────────────');
  const wfFiles = fs.readdirSync(WF_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();

  const wfIds = {};
  for (const file of wfFiles) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(WF_DIR, file), 'utf8'));
      const id  = await upsertWorkflow(raw, credMap);
      if (id) { wfIds[raw.name] = id; process.stdout.write(`  ✅ ${raw.name}\n`); }
    } catch (e) {
      console.warn(`  ⚠️  ${file}: ${e.message}`);
    }
  }

  // 6. Activate
  console.log('\n── 6. Activate workflows ───────────────────────────────────');
  const allWfs = await listWorkflows();

  for (const wf of allWfs) {
    const { active, status, skipped, reactivated } = await activateWorkflow(wf.id);
    if (skipped) {
      console.log(`  ⏭  Already active: ${wf.name}`);
    } else if (reactivated) {
      console.log(`  🔄 Re-activated latest version: ${wf.name}  (HTTP ${status})`);
    } else {
      console.log(`  ${active ? '✅' : '⚠️ '} ${wf.name}  (HTTP ${status})`);
    }
  }

  // 7. Summary
  console.log('\n── 7. Summary ──────────────────────────────────────────────');
  const final = await listWorkflows();
  const activeCount = final.filter(w => w.active).length;
  console.log(`\n  🎉 ${activeCount}/${final.length} workflows active`);
  for (const wf of final.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${wf.active ? '✅' : '⚠️ '} ${wf.name}`);
  }
  if (waToken === 'PLACEHOLDER_WA_TOKEN') {
    console.log('\n  ⚠️  WhatsApp token is a placeholder.');
    console.log('     Set WA_ACCESS_TOKEN in .env, then re-run this script.\n');
  } else {
    console.log('\n  ✅ WhatsApp credential is configured with a real token.\n');
  }
}

main().catch(e => {
  console.error('\n❌ Setup failed:', e.message);
  process.exit(1);
});
