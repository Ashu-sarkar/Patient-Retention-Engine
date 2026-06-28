#!/usr/bin/env node
'use strict';

/**
 * Sync Twilio Content SIDs from message-templates/twilio-content-sids.json into:
 *   - .env (local / docker-compose)
 *   - build/railway-twilio-content.env (paste or `railway variables --set` bulk)
 *   - build/supabase-prescription-twilio.env (edge function secrets subset)
 *
 * Usage:
 *   node scripts/sync-twilio-content-env.js
 *   node scripts/sync-twilio-content-env.js --check     # exit 1 if .env drifts
 *   node scripts/sync-twilio-content-env.js --railway # run railway variables set
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  getFullEnvMap,
  getTemplates,
  validateEnvMap,
} = require('./lib/twilio-content-sids');

const repoRoot = path.join(__dirname, '..');
const envPath = path.join(repoRoot, '.env');
const buildDir = path.join(repoRoot, 'build');

function parseEnvLines(text) {
  return text.split('\n');
}

function upsertEnvFile(filePath, entries) {
  const lines = fs.existsSync(filePath) ? parseEnvLines(fs.readFileSync(filePath, 'utf8')) : [];
  const keys = new Set(Object.keys(entries));
  const out = [];
  const seen = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      out.push(line);
      continue;
    }
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim();
    if (keys.has(key)) {
      out.push(`${key}=${entries[key]}`);
      seen.add(key);
    } else {
      out.push(line);
    }
  }

  const block = ['', '# v2 Twilio Content SIDs — synced from message-templates/twilio-content-sids.json'];
  for (const row of getTemplates()) {
    if (!seen.has(row.env)) block.push(`${row.env}=${entries[row.env]}`);
  }
  for (const [key, value] of Object.entries(entries)) {
    if (!seen.has(key) && !getTemplates().some(t => t.env === key)) {
      block.push(`${key}=${value}`);
    }
  }
  if (block.length > 2) out.push(...block);

  fs.writeFileSync(filePath, out.join('\n').replace(/\n*$/, '\n'));
}

function writeBulkEnv(outPath, entries, comment) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const lines = [
    `# ${comment}`,
    `# Generated ${new Date().toISOString()}`,
    '',
  ];
  for (const [key, value] of Object.entries(entries)) {
    lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`);
}

function readEnvMap(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const map = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const i = trimmed.indexOf('=');
    map[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim();
  }
  return map;
}

function railwayBin() {
  try {
    execSync('command -v railway', { stdio: 'pipe', shell: true });
    return 'railway';
  } catch {
    return 'npx @railway/cli';
  }
}

function pushRailway(entries) {
  const bin = railwayBin();
  if (!process.env.RAILWAY_TOKEN && !process.env.RAILWAY_API_TOKEN) {
    try {
      execSync(`${bin} whoami`, { stdio: 'pipe', shell: true });
    } catch {
      console.warn('⚠️  Railway CLI not logged in — wrote build/railway-twilio-content.env for manual import');
      console.warn('   Run: railway login && railway link -p Vaitalcare');
      return false;
    }
  }
  const pairs = Object.entries(entries);
  for (const [key, value] of pairs) {
    execSync(`${bin} variable set ${key}=${value} --skip-deploys`, {
      stdio: 'inherit',
      cwd: repoRoot,
      shell: true,
    });
  }
  console.log(`   Set ${pairs.length} variable(s); redeploy n8n on Railway when ready.`);
  return true;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has('--check');
  const pushToRailway = args.has('--railway');

  const entries = getFullEnvMap();
  const current = readEnvMap(envPath);
  const drift = Object.entries(entries).filter(([k, v]) => current[k] !== v);

  if (checkOnly) {
    const { errors } = validateEnvMap(current);
    if (errors.length) {
      console.error('❌ .env missing required Twilio Content SIDs:\n  ' + errors.join('\n  '));
      process.exit(1);
    }
    if (drift.length) {
      console.error(`❌ .env drift (${drift.length} key(s)). Run: npm run sync:twilio-content`);
      for (const [k, v] of drift.slice(0, 8)) {
        console.error(`   ${k}: ${current[k] || '(empty)'} → ${v}`);
      }
      process.exit(1);
    }
    console.log('✅ .env Twilio Content SIDs match registry');
    process.exit(0);
  }

  if (!fs.existsSync(envPath)) {
    console.error('❌ .env not found — copy .env.example first');
    process.exit(1);
  }

  upsertEnvFile(envPath, entries);
  writeBulkEnv(
    path.join(buildDir, 'railway-twilio-content.env'),
    entries,
    'Railway n8n service — Twilio Content template SIDs',
  );

  const prescriptionKeys = [
    'TWILIO_CONTENT_PRESCRIPTION_DELIVERY',
    'TWILIO_CONTENT_PRESCRIPTION_WITH_FOLLOWUP',
    'TWILIO_CONTENT_PRESCRIPTION_JOURNEY_START',
    'TWILIO_CONTENT_MEDICINE_JOURNEY_DAY1_MORNING',
    'TWILIO_CONTENT_MEDICINE_JOURNEY_DAY1_EVENING',
    'TWILIO_CONTENT_MEDICINE_JOURNEY_MIDPOINT',
    'TWILIO_CONTENT_MEDICINE_JOURNEY_DAILY',
    'TWILIO_CONTENT_MEDICINE_JOURNEY_LAST_DAY',
    'TWILIO_CONTENT_MEDICINE_JOURNEY_COMPLETE',
    'TWILIO_CONTENT_MEDICINE_REMINDER_MORNING',
    'TWILIO_CONTENT_MEDICINE_REMINDER_AFTERNOON',
    'TWILIO_CONTENT_MEDICINE_REMINDER_NIGHT',
  ];
  const prescriptionEntries = Object.fromEntries(
    prescriptionKeys.filter(k => entries[k]).map(k => [k, entries[k]]),
  );
  writeBulkEnv(
    path.join(buildDir, 'supabase-prescription-twilio.env'),
    prescriptionEntries,
    'Supabase prescription-delivery edge function — Twilio Content SIDs',
  );

  console.log(`✅ Synced ${Object.keys(entries).length} TWILIO_CONTENT_* keys to .env`);
  console.log(`   Registry: message-templates/twilio-content-sids.json`);
  console.log(`   Railway bulk: build/railway-twilio-content.env`);
  console.log(`   Supabase bulk: build/supabase-prescription-twilio.env`);

  if (pushToRailway) {
    console.log('\n── Pushing to Railway ──');
    if (pushRailway(entries)) console.log('✅ Railway variables updated');
  } else {
    console.log('\nTo push to Railway: npm run sync:twilio-content:railway');
    console.log('Then Supabase edge: npm run sync:prescription-secrets');
  }
}

main();
