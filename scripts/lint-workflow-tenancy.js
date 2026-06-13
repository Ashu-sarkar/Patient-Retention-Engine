#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const workflowsDir = path.join(__dirname, '..', 'workflows');
const tenantTables = [
  'patients',
  'patient_visits',
  'prescriptions',
  'message_logs',
  'message_ledger',
  'hospital_boarding',
];

function walk(value, fn) {
  if (!value || typeof value !== 'object') return;
  fn(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(item => walk(item, fn));
    else walk(child, fn);
  }
}

const failures = [];
for (const file of fs.readdirSync(workflowsDir).filter(name => name.endsWith('.json'))) {
  const full = path.join(workflowsDir, file);
  const workflow = JSON.parse(fs.readFileSync(full, 'utf8'));
  walk(workflow, node => {
    const query = node.parameters?.query;
    if (typeof query !== 'string') return;
    const lower = query.toLowerCase();
    for (const table of tenantTables) {
      const touchesTable = lower.includes(`public.${table}`) || lower.includes(` ${table} `);
      if (!touchesTable) continue;
      const isSchemaUtility =
        lower.includes('alter table') ||
        lower.includes('create table') ||
        lower.includes('information_schema') ||
        lower.includes('pg_constraint') ||
        lower.includes('get_or_create_clinic_id');
      if (isSchemaUtility) continue;
      if (!lower.includes('clinic_id')) {
        failures.push(`${file}:${node.name || node.id || 'unnamed'} touches ${table} without clinic_id`);
      }
    }
  });
}

if (failures.length) {
  console.error('[workflow-tenancy] Failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('[workflow-tenancy] Passed.');
