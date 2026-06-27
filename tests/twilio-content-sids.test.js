#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  getFullEnvMap,
  getRequiredProductionKeys,
  isValidSid,
  loadRegistry,
  validateEnvMap,
} = require('../scripts/lib/twilio-content-sids');

const repoRoot = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

function test(label, fn) {
  process.stdout.write(`  ${label} … `);
  try {
    fn();
    process.stdout.write('✅ PASS\n');
    passed++;
  } catch (e) {
    process.stdout.write(`❌ FAIL\n       → ${e.message}\n`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function main() {
  console.log('\n── Twilio Content SID registry tests ──\n');
  const registry = loadRegistry();

  test('1.1  Registry has 21 v2 templates', () => {
    assert(registry.templates.length === 21, `expected 21, got ${registry.templates.length}`);
  });

  test('1.2  All template SIDs are HX format', () => {
    for (const row of registry.templates) {
      assert(isValidSid(row.sid), `${row.env} has invalid SID ${row.sid}`);
    }
  });

  test('1.3  Env keys are unique', () => {
    const keys = registry.templates.map(t => t.env);
    assert(new Set(keys).size === keys.length, 'duplicate env keys');
  });

  test('1.4  Legacy aliases resolve to primary SIDs', () => {
    const primary = Object.fromEntries(registry.templates.map(t => [t.env, t.sid]));
    for (const [alias, primaryKey] of Object.entries(registry.legacy_aliases)) {
      assert(primary[primaryKey], `unknown primary ${primaryKey} for alias ${alias}`);
    }
  });

  test('1.5  whatsapp-cards.json env keys covered by registry', () => {
    const cardsPath = path.join(repoRoot, 'build', 'whatsapp-cards.json');
    assert(fs.existsSync(cardsPath), 'run npm run generate:whatsapp-cards first');
    const cards = JSON.parse(fs.readFileSync(cardsPath, 'utf8'));
    const registryIds = new Set(registry.templates.map(t => t.id));
    for (const card of cards.cards) {
      assert(registryIds.has(card.id), `card ${card.id} missing from registry`);
    }
  });

  test('1.6  Workflows reference env keys present in full map', () => {
    const fullMap = getFullEnvMap();
    const optional = new Set([
      'TWILIO_CONTENT_REACTIVATION',
      'TWILIO_CONTENT_MEDICINE_REMINDER',
      'TWILIO_CONTENT_MEDICINE_MORNING_DOSE',
      'TWILIO_CONTENT_MEDICINE_AFTERNOON_DOSE',
      'TWILIO_CONTENT_MEDICINE_EVENING_DOSE',
      'TWILIO_CONTENT_MEDICINE_COURSE_COMPLETE',
    ]);
    const wfDir = path.join(repoRoot, 'workflows');
    const missing = new Set();
    for (const file of fs.readdirSync(wfDir).filter(f => f.endsWith('.json'))) {
      const text = fs.readFileSync(path.join(wfDir, file), 'utf8');
      for (const match of text.matchAll(/TWILIO_CONTENT_[A-Z0-9_]+/g)) {
        const key = match[0];
        if (!fullMap[key] && !optional.has(key)) missing.add(`${file}: ${key}`);
      }
    }
    assert(missing.size === 0, `unmapped keys: ${[...missing].join(', ')}`);
  });

  test('1.7  .env matches registry (if present)', () => {
    const envPath = path.join(repoRoot, '.env');
    if (!fs.existsSync(envPath)) return;
    const env = Object.fromEntries(
      fs.readFileSync(envPath, 'utf8')
        .split('\n')
        .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
        .map(l => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    );
    const { errors } = validateEnvMap(env);
    assert(errors.length === 0, errors.join('; '));
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
