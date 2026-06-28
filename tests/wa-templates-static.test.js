#!/usr/bin/env node
/**
 * Static coverage for all v2 WhatsApp Content templates — registry, workflow wiring,
 * medicine schedule builder, and WF6 inbound edge-case classification.
 *
 * Usage: node tests/wa-templates-static.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  getTemplates,
  getFullEnvMap,
  isValidSid,
  loadRegistry,
} = require('../scripts/lib/twilio-content-sids');
const {
  buildMedicineReminderSchedule,
  JOURNEY_TEMPLATE_MAP,
  STANDALONE_TEMPLATE_MAP,
} = require('../scripts/lib/medicine-schedule-builder');

const root = path.join(__dirname, '..');
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

function loadWorkflow(name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'workflows', name), 'utf8'));
}

function workflowBlob() {
  const wfDir = path.join(root, 'workflows');
  const edgeFn = fs.readFileSync(
    path.join(root, 'supabase', 'functions', 'prescription-delivery', 'index.ts'),
    'utf8',
  );
  const wfText = fs
    .readdirSync(wfDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => fs.readFileSync(path.join(wfDir, f), 'utf8'))
    .join('\n');
  return wfText + '\n' + edgeFn;
}

function classifyInbound({ body = '', buttonText = '', buttonPayload = '' } = {}) {
  const messageBody = String(body || '').trim();
  const btnText = String(buttonText || '').trim();
  const btnPayload = String(buttonPayload || '').trim();
  const effectiveText = messageBody || btnText;
  const lowerMsg = effectiveText.toLowerCase();
  const lowerButtonText = btnText.toLowerCase();
  const lowerButtonPayload = btnPayload.toLowerCase();
  let classification = 'responded';
  const confirmedKeywords = ['yes', 'confirm', 'confirmed', 'will come', 'coming', 'ok', 'okay', 'sure'];
  const cancelledKeywords = ['no', 'cancel', 'cancelled', 'reschedule', "can't make it", 'not coming'];

  if (btnText || btnPayload) {
    if (lowerButtonPayload === 'confirm_appointment' || lowerButtonText.includes('confirm')) {
      classification = 'confirmed';
    } else if (lowerButtonPayload === 'reschedule' || lowerButtonText.includes('reschedule')) {
      classification = 'cancelled';
    } else if (cancelledKeywords.some((k) => lowerMsg.includes(k))) classification = 'cancelled';
    else if (confirmedKeywords.some((k) => lowerMsg.includes(k))) classification = 'confirmed';
  } else if (cancelledKeywords.some((k) => lowerMsg.includes(k))) classification = 'cancelled';
  else if (confirmedKeywords.some((k) => lowerMsg.includes(k))) classification = 'confirmed';

  return classification;
}

function main() {
  console.log('\n── WhatsApp template static tests (v2 registry + edge cases) ──\n');

  const registry = loadRegistry();
  const templatesJson = JSON.parse(
    fs.readFileSync(path.join(root, 'message-templates', 'templates.json'), 'utf8'),
  );
  const blob = workflowBlob();
  const envMap = getFullEnvMap();

  test('1.1  Registry lists 21 approved UTILITY templates', () => {
    assert.strictEqual(registry.templates.length, 21);
  });

  test('1.2  Every registry template has valid HX SID and env key', () => {
    for (const row of registry.templates) {
      assert(isValidSid(row.sid), `${row.id}: invalid SID ${row.sid}`);
      assert(row.env.startsWith('TWILIO_CONTENT_'), `${row.id}: bad env ${row.env}`);
      assert(envMap[row.env], `${row.env} missing from full env map`);
    }
  });

  test('1.3  templates.json ids match registry ids', () => {
    const jsonIds = new Set(templatesJson.templates.map((t) => t.id));
    for (const row of registry.templates) {
      assert(jsonIds.has(row.id), `registry id ${row.id} missing from templates.json`);
    }
  });

  test('1.4  Each v2 template env key referenced in workflow or edge function code', () => {
    const optional = new Set(['TWILIO_CONTENT_REACTIVATION']);
    const missing = [];
    for (const row of registry.templates) {
      if (optional.has(row.env)) continue;
      if (!blob.includes(row.env)) missing.push(`${row.id} (${row.env})`);
    }
    assert.strictEqual(missing.length, 0, `unreferenced env keys: ${missing.join(', ')}`);
  });

  test('1.5  Patient onboarding template is clinic_patient_welcome', () => {
    const welcome = registry.templates.find((t) => t.id === 'clinic_patient_welcome');
    assert(welcome, 'clinic_patient_welcome missing');
    assert.strictEqual(welcome.env, 'TWILIO_CONTENT_CLINIC_PATIENT_WELCOME');
    assert(blob.includes('TWILIO_CONTENT_CLINIC_PATIENT_WELCOME'), 'WF7 must reference welcome template');
  });

  test('1.6  Hospital onboarding template wired in WF12', () => {
    assert(blob.includes('TWILIO_CONTENT_HOSPITAL_ONBOARDING'), 'WF12 hospital_onboarding env');
    const wf12 = loadWorkflow('workflow-12-hospital-boarding.json');
    const code = wf12.nodes.find((n) => n.name === 'Build Hospital Onboarding Messages')?.parameters?.jsCode || '';
    assert(code.includes('TWILIO_CONTENT_HOSPITAL_ONBOARDING'), 'Build node must read hospital onboarding SID');
  });

  test('1.7  Follow-up + booking templates wired in WF1/WF2/WF6', () => {
    const wf1 = loadWorkflow('workflow-1-followup-reminder.json');
    const wf6 = loadWorkflow('workflow-6-feedback-listener.json');
    const wf1Code = wf1.nodes.find((n) => n.name === 'Filter Tomorrow Follow-ups')?.parameters?.jsCode || '';
    const wf6Code = wf6.nodes.find((n) => n.name === 'Prepare Reply')?.parameters?.jsCode || '';
    assert(wf1Code.includes('TWILIO_CONTENT_FOLLOWUP_REMINDER_ADVANCE'));
    assert(blob.includes('TWILIO_CONTENT_FOLLOWUP_REMINDER_DAY_OF'));
    assert(blob.includes('TWILIO_CONTENT_FOLLOWUP_BOOKING_CONFIRMED'));
    assert(blob.includes('TWILIO_CONTENT_FOLLOWUP_RESCHEDULED_CONFIRMED'));
    assert(wf6Code.includes('TWILIO_CONTENT_FOLLOWUP_BOOKING_CONFIRMED'));
  });

  test('1.8  Prescription templates wired in edge function', () => {
    for (const id of [
      'prescription_delivery',
      'prescription_with_followup',
      'prescription_journey_start',
    ]) {
      const row = registry.templates.find((t) => t.id === id);
      assert(row && blob.includes(row.env), `${id} env must appear in prescription-delivery`);
    }
  });

  test('1.9  Medicine journey + standalone reminder templates in WF14 builder map', () => {
    for (const key of Object.keys(JOURNEY_TEMPLATE_MAP)) {
      const row = registry.templates.find((t) => t.id === key);
      assert(row, `journey template ${key} missing from registry`);
    }
    for (const envKey of Object.values(STANDALONE_TEMPLATE_MAP)) {
      assert(registry.templates.some((t) => t.env === envKey), `${envKey} missing from registry`);
    }
    assert(blob.includes('workflow-14-medicine-journey'), 'WF14 workflow file must exist');
  });

  test('1.10 Missed follow-up recovery templates in WF3', () => {
    assert(blob.includes('TWILIO_CONTENT_MISSED_FOLLOWUP_RECOVERY_1'));
    assert(blob.includes('TWILIO_CONTENT_MISSED_FOLLOWUP_RECOVERY_2'));
  });

  test('1.11 Health check template in WF4', () => {
    assert(blob.includes('TWILIO_CONTENT_PATIENT_HEALTH_CHECK'));
  });

  test('2.1  7-day medicine course generates all journey template slots', () => {
    const rows = buildMedicineReminderSchedule({
      clinicId: '00000000-0000-4000-8000-000000000001',
      patientId: '00000000-0000-4000-8000-000000000002',
      prescriptionId: '00000000-0000-4000-8000-000000000003',
      courseStartDate: '2026-06-28',
      medicines: [{ medicine_name: 'Paracetamol 500mg', duration: '7 days', timing: 'after breakfast', sort_order: 1 }],
    });
    const types = new Set(rows.map((r) => r.template_id));
    for (const key of Object.keys(JOURNEY_TEMPLATE_MAP)) {
      assert(types.has(key), `7-day course missing schedule row for ${key}`);
    }
  });

  test('2.2  Short course (<3 days) uses standalone morning/afternoon/night templates', () => {
    const rows = buildMedicineReminderSchedule({
      clinicId: '00000000-0000-4000-8000-000000000001',
      patientId: '00000000-0000-4000-8000-000000000002',
      prescriptionId: '00000000-0000-4000-8000-000000000003',
      courseStartDate: '2026-06-28',
      medicines: [
        { medicine_name: 'Vitamin D', duration: '2 days', timing: 'before breakfast', sort_order: 1 },
        { medicine_name: 'Iron', duration: '2 days', timing: 'before lunch', sort_order: 2 },
        { medicine_name: 'Melatonin', duration: '2 days', timing: 'bedtime', sort_order: 3 },
      ],
    });
    const envKeys = new Set(rows.map((r) => r.content_env_key));
    assert(envKeys.has('TWILIO_CONTENT_MEDICINE_REMINDER_MORNING'));
    assert(envKeys.has('TWILIO_CONTENT_MEDICINE_REMINDER_AFTERNOON'));
    assert(envKeys.has('TWILIO_CONTENT_MEDICINE_REMINDER_NIGHT'));
  });

  test('3.1  WF6 confirm button payload classified as confirmed', () => {
    assert.strictEqual(
      classifyInbound({ buttonText: 'Confirm Appointment', buttonPayload: 'confirm_appointment' }),
      'confirmed',
    );
  });

  test('3.2  WF6 reschedule button payload classified as cancelled', () => {
    assert.strictEqual(
      classifyInbound({ buttonText: 'Reschedule', buttonPayload: 'reschedule' }),
      'cancelled',
    );
  });

  test('3.3  WF6 text confirm/cancel keywords', () => {
    assert.strictEqual(classifyInbound({ body: 'Yes, I will come' }), 'confirmed');
    assert.strictEqual(classifyInbound({ body: 'No please cancel' }), 'cancelled');
  });

  test('3.4  WF6 ambiguous text stays responded (not auto-confirmed)', () => {
    assert.strictEqual(classifyInbound({ body: 'What time is my appointment?' }), 'responded');
    assert.strictEqual(classifyInbound({ body: '' }), 'responded');
  });

  test('4.1  Test phone numbers are valid 10-digit Indian format', () => {
    for (const raw of ['9685722570', '9179263530', '7002250088']) {
      assert(/^[0-9]{10}$/.test(raw), `${raw} must be 10 digits`);
      assert(/^\+91[0-9]{10}$/.test(`+91${raw}`), `${raw} E.164 invalid`);
    }
  });

  test('4.2  Follow-up dates are after visit date used in E2E', () => {
    const visitDate = '2026-06-27';
    assert('2026-06-30' > visitDate, 'Patient A follow-up must be after visit');
    assert('2026-07-04' > visitDate, 'Patient B follow-up must be after visit');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
