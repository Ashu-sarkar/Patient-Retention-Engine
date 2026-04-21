#!/usr/bin/env node
/**
 * Patient Retention Engine — n8n Setup Script
 *
 * Automatically:
 *  1. Creates Supabase (Postgres) credential in n8n
 *  2. Creates WhatsApp Business API (HTTP Header Auth) credential in n8n
 *  3. Re-imports the fixed workflow JSONs via n8n API
 *  4. Activates all workflows (WF1–WF8, WF11, WF12)
 *
 * Run ONCE before tests:
 *   node tests/setup-n8n.js
 *
 * Requirements: n8n running at localhost:5678
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Parse .env ───────────────────────────────────────────────────────────────
function parseEnv(filePath) {
  try {
    return Object.fromEntries(
      fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
    );
  } catch { return {}; }
}

const env     = parseEnv(path.join(__dirname, '..', '.env'));
const N8N_URL = `http://${env.N8N_HOST || 'localhost'}:${env.N8N_PORT || '5678'}`;
const N8N_B64 = Buffer.from(`${env.N8N_BASIC_AUTH_USER || 'admin'}:${env.N8N_BASIC_AUTH_PASSWORD || 'strongpass'}`).toString('base64');

const WF_DIR  = path.join(__dirname, '..', 'workflows');

// Workflow name fragments expected in n8n
const WORKFLOW_FRAGMENTS = ['WF1', 'WF2', 'WF3', 'WF4', 'WF5', 'WF6', 'WF7', 'WF8', 'WF11', 'WF12'];

// ── HTTP Helper ───────────────────────────────────────────────────────────────
async function n8n(method, endpoint, body) {
  const url = `${N8N_URL}${endpoint}`;
  const opts = {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Basic ${N8N_B64}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(url, opts);
  const text = await res.text();
  let   json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

// ── Credential helpers ────────────────────────────────────────────────────────
async function listCredentials() {
  const { ok, json } = await n8n('GET', '/api/v1/credentials?limit=100');
  return ok ? (json.data || []) : [];
}

async function createCredential(name, type, data) {
  const existing = await listCredentials();
  const found    = existing.find(c => c.name === name);
  if (found) {
    console.log(`  ⏭  Credential "${name}" already exists (id: ${found.id})`);
    return found.id;
  }
  const { ok, json } = await n8n('POST', '/api/v1/credentials', { name, type, data });
  if (!ok) {
    console.warn(`  ⚠️  Could not create "${name}": ${JSON.stringify(json)}`);
    return null;
  }
  console.log(`  ✅ Created credential "${name}" (id: ${json.id})`);
  return json.id;
}

// ── Workflow helpers ──────────────────────────────────────────────────────────
async function listWorkflows() {
  const { ok, json } = await n8n('GET', '/api/v1/workflows?limit=100');
  return ok ? (json.data || []) : [];
}

async function upsertWorkflow(wfJson) {
  const workflows = await listWorkflows();
  const existing  = workflows.find(w => w.id === wfJson.id || w.name === wfJson.name);

  if (existing) {
    // Update existing workflow with the fixed JSON
    const merged = { ...existing, ...wfJson, id: existing.id };
    const { ok, json } = await n8n('PUT', `/api/v1/workflows/${existing.id}`, merged);
    if (!ok) {
      console.warn(`  ⚠️  Could not update "${wfJson.name}": ${JSON.stringify(json).substring(0, 200)}`);
      return existing.id;
    }
    console.log(`  ✅ Updated workflow "${wfJson.name}" (id: ${existing.id})`);
    return existing.id;
  } else {
    const { ok, json } = await n8n('POST', '/api/v1/workflows', wfJson);
    if (!ok) {
      console.warn(`  ⚠️  Could not create "${wfJson.name}": ${JSON.stringify(json).substring(0, 200)}`);
      return null;
    }
    console.log(`  ✅ Created workflow "${wfJson.name}" (id: ${json.id})`);
    return json.id;
  }
}

async function activateWorkflow(wfId) {
  const { ok } = await n8n('PATCH', `/api/v1/workflows/${wfId}`, { active: true });
  return ok;
}

// ── Patch credential IDs into a workflow object ───────────────────────────────
function patchCredentials(wfJson, postgresCredId, waCredId) {
  const patched = JSON.parse(JSON.stringify(wfJson)); // deep clone
  for (const node of patched.nodes || []) {
    if (!node.credentials) continue;
    if (node.credentials.postgres && postgresCredId) {
      node.credentials.postgres.id   = postgresCredId;
      node.credentials.postgres.name = 'Supabase (Postgres)';
    }
    if (node.credentials.httpHeaderAuth && waCredId) {
      node.credentials.httpHeaderAuth.id   = waCredId;
      node.credentials.httpHeaderAuth.name = 'WhatsApp Business API';
    }
  }
  return patched;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║         Patient Retention Engine — n8n Setup             ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  n8n: ${N8N_URL}\n`);

  // 1. Health check
  console.log('── 1. n8n connectivity ─────────────────────────────────────');
  try {
    const res = await fetch(`${N8N_URL}/healthz`);
    if (!res.ok && res.status !== 401) throw new Error(`status ${res.status}`);
    console.log('  ✅ n8n is reachable');
  } catch (e) {
    console.error(`  ❌ Cannot reach n8n at ${N8N_URL}: ${e.message}`);
    console.error('     → Make sure docker compose is running: docker compose up -d --build');
    process.exit(1);
  }

  // 2. Create Supabase Postgres credential
  console.log('\n── 2. Credentials ──────────────────────────────────────────');
  const postgresCredId = await createCredential(
    'Supabase (Postgres)',
    'postgres',
    {
      host:                 env.SUPABASE_DB_HOST,
      port:                 parseInt(env.SUPABASE_DB_PORT || '5432'),
      database:             env.SUPABASE_DB_NAME  || 'postgres',
      user:                 env.SUPABASE_DB_USER  || 'postgres',
      password:             env.SUPABASE_DB_PASSWORD,
      ssl:                  true,
      sslRejectUnauthorized: true,
    }
  );

  // Also create the "Supabase DB" alias used by some WF nodes
  const postgresCredId2 = await createCredential(
    'Supabase DB',
    'postgres',
    {
      host:                 env.SUPABASE_DB_HOST,
      port:                 parseInt(env.SUPABASE_DB_PORT || '5432'),
      database:             env.SUPABASE_DB_NAME  || 'postgres',
      user:                 env.SUPABASE_DB_USER  || 'postgres',
      password:             env.SUPABASE_DB_PASSWORD,
      ssl:                  true,
      sslRejectUnauthorized: true,
    }
  );

  // WhatsApp credential (httpHeaderAuth) — uses placeholder token so WA calls will fail
  // gracefully (error logged, workflow continues). Tests only verify the trigger is reached.
  const waToken      = env.WA_ACCESS_TOKEN || 'PLACEHOLDER_WA_TOKEN';
  const waCredId     = await createCredential(
    'WhatsApp Business API',
    'httpHeaderAuth',
    {
      name:  'Authorization',
      value: `Bearer ${waToken}`,
    }
  );

  // 3. Import / update fixed workflow JSONs
  console.log('\n── 3. Workflow import (with patched credentials) ────────────');
  const wfFiles = fs.readdirSync(WF_DIR).filter(f => f.endsWith('.json')).sort();
  const wfIds   = {};

  for (const file of wfFiles) {
    try {
      const raw     = JSON.parse(fs.readFileSync(path.join(WF_DIR, file), 'utf8'));
      const patched = patchCredentials(raw, postgresCredId || postgresCredId2, waCredId);
      const id      = await upsertWorkflow(patched);
      if (id) wfIds[raw.name] = id;
    } catch (e) {
      console.warn(`  ⚠️  Failed to process ${file}: ${e.message}`);
    }
  }

  // 4. Activate all expected workflows
  console.log('\n── 4. Activating workflows ─────────────────────────────────');
  const all = await listWorkflows();
  const toActivate = all.filter(w => WORKFLOW_FRAGMENTS.some(fragment => w.name.includes(fragment)));

  const missing = WORKFLOW_FRAGMENTS.filter(fragment =>
    !all.some(w => w.name.includes(fragment))
  );
  if (missing.length > 0) {
    console.warn(`  ⚠️  Missing workflows in n8n after import: ${missing.join(', ')}`);
  }

  for (const wf of toActivate) {
    if (wf.active) {
      console.log(`  ⏭  "${wf.name}" already active`);
      continue;
    }
    const ok = await activateWorkflow(wf.id);
    console.log(ok ? `  ✅ Activated "${wf.name}"` : `  ⚠️  Could not activate "${wf.name}" (may need manual step in n8n UI)`);
  }

  // 5. Summary
  console.log('\n── 5. Setup complete ───────────────────────────────────────');
  console.log('  Run tests with: node tests/run-tests.js\n');
}

main().catch(e => {
  console.error('\n❌ Setup failed:', e.message);
  process.exit(1);
});
