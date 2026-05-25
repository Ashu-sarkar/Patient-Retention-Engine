#!/usr/bin/env node
/**
 * Quick Supabase checks for production debugging.
 * Usage: node production-test-playbook/verify.js patient +919685722570
 */

'use strict';

const fs = require('fs');
const path = require('path');

function parseEnv(filePath) {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    );
  } catch {
    return {};
  }
}

const env = parseEnv(path.join(__dirname, '..', '.env'));
const SB_URL = env.SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

const hdr = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
};

async function sbGet(table, qs) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, { headers: hdr });
  const data = await res.json().catch(() => []);
  if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function patient(phone) {
  const rows = await sbGet(
    'patients',
    `phone=eq.${encodeURIComponent(phone)}&select=id,patient_code,name,status,doctor_name,hospital_name`
  );
  const pat = rows[0];
  console.log('\n── Patient ──');
  console.log(pat ? JSON.stringify(pat, null, 2) : '(not found)');
  if (!pat) return;
  const visits = await sbGet(
    'patient_visits',
    `patient_id=eq.${pat.id}&order=checked_in_at.desc&limit=5&select=id,visit_date,visit_status,clinic_name,doctor_name,chief_complaint`
  );
  console.log('\n── Recent visits ──');
  console.log(JSON.stringify(visits, null, 2));
}

async function prescriptions(phone) {
  const rows = await sbGet(
    'patients',
    `phone=eq.${encodeURIComponent(phone)}&select=id,patient_code&limit=1`
  );
  const pat = rows[0];
  if (!pat) {
    console.log('Patient not found');
    return;
  }
  const rx = await sbGet(
    'prescriptions',
    `patient_id=eq.${pat.id}&order=issued_at.desc&limit=5&select=id,status,delivery_status,pdf_url,issued_at,diagnosis`
  );
  console.log('\n── Prescriptions ──');
  console.log(JSON.stringify(rx, null, 2));
  const logs = await sbGet(
    'message_logs',
    `phone=eq.${encodeURIComponent(phone)}&message_type=eq.prescription_pdf&order=created_at.desc&limit=3&select=delivery_status,twilio_message_sid,message_sent,created_at`
  );
  console.log('\n── prescription_pdf message_logs ──');
  console.log(JSON.stringify(logs, null, 2));
}

async function logs(workflow) {
  const rows = await sbGet(
    'system_logs',
    `workflow_name=eq.${encodeURIComponent(workflow)}&order=created_at.desc&limit=10&select=log_level,message,created_at`
  );
  console.log(`\n── system_logs (${workflow}) ──`);
  console.log(JSON.stringify(rows, null, 2));
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!SB_URL || !SB_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env');
    process.exit(1);
  }
  switch (cmd) {
    case 'patient':
      await patient(arg || '+919685722570');
      break;
    case 'prescriptions':
      await prescriptions(arg || '+919685722570');
      break;
    case 'logs':
      await logs(arg || 'workflow-13-prescription-delivery');
      break;
    default:
      console.log('Usage: node production-test-playbook/verify.js <patient|prescriptions|logs> [arg]');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
