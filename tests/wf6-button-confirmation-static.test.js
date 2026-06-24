#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');

function includes(haystack, needle, label) {
  assert(haystack.includes(needle), `${label || 'Expected content'} missing: ${needle}`);
}

function loadWorkflow(name) {
  const file = path.join(root, 'workflows', name);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function nodeCode(workflow, nodeName) {
  const node = workflow.nodes.find((n) => n.name === nodeName);
  assert(node, `workflow node missing: ${nodeName}`);
  return node.parameters.jsCode || '';
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
  const confirmedKeywords = ['yes', 'confirm', 'confirmed', 'will come', 'coming', 'ok', 'okay', 'sure', 'yep', 'yup', 'absolutely', 'definitely', "i'll be there", 'see you', 'good'];
  const cancelledKeywords = ['no', 'cancel', 'cancelled', 'reschedule', "can't make it", 'cannot come', 'not coming', 'postpone', 'change date'];
  const bookKeywords = ['book', 'schedule', 'appointment', 'want to book', 'fix appointment'];

  if (btnText || btnPayload) {
    if (lowerButtonPayload === 'confirm_appointment' || lowerButtonText.includes('confirm')) classification = 'confirmed';
    else if (lowerButtonPayload === 'reschedule' || lowerButtonText.includes('reschedule')) classification = 'cancelled';
    else if (lowerMsg === 'help' || ['not well', 'pain', 'emergency', 'urgent', 'need doctor', 'call me'].some((k) => lowerMsg.includes(k))) classification = 'help';
    else if (cancelledKeywords.some((k) => lowerMsg.includes(k))) classification = 'cancelled';
    else if (confirmedKeywords.some((k) => lowerMsg.includes(k))) classification = 'confirmed';
    else if (bookKeywords.some((k) => lowerMsg.includes(k))) classification = 'book';
  } else if (lowerMsg === 'help' || ['not well', 'pain', 'emergency', 'urgent', 'need doctor', 'call me'].some((k) => lowerMsg.includes(k))) classification = 'help';
  else if (cancelledKeywords.some((k) => lowerMsg.includes(k))) classification = 'cancelled';
  else if (confirmedKeywords.some((k) => lowerMsg.includes(k))) classification = 'confirmed';
  else if (bookKeywords.some((k) => lowerMsg.includes(k))) classification = 'book';

  return classification;
}

const templates = JSON.parse(fs.readFileSync(path.join(root, 'message-templates', 'templates.json'), 'utf8'));
const confirmationTemplate = templates.templates.find((t) => t.id === 'followup_reminder_advance');
assert(confirmationTemplate, 'followup_reminder_advance template must exist');
assert(Array.isArray(confirmationTemplate.actions) && confirmationTemplate.actions.length === 2, 'followup_reminder_advance must define two Quick Reply actions');
assert(confirmationTemplate.twilio_content_env === 'TWILIO_CONTENT_FOLLOWUP_REMINDER_ADVANCE', 'followup_reminder_advance env var');

const wf1 = loadWorkflow('workflow-1-followup-reminder.json');
const wf2 = loadWorkflow('workflow-2-sameday-reminder.json');
const wf6 = loadWorkflow('workflow-6-feedback-listener.json');

includes(nodeCode(wf1, 'Filter Tomorrow Follow-ups'), 'TWILIO_CONTENT_FOLLOWUP_REMINDER_ADVANCE', 'WF1 uses v2 advance reminder template');
includes(nodeCode(wf2, "Filter Today's Appointments"), "response_status === 'confirmed'", 'WF2 skips confirmed patients');

const parseCode = nodeCode(wf6, 'Parse and Classify Message');
includes(parseCode, 'ButtonText', 'WF6 parse reads ButtonText');
includes(parseCode, 'ButtonPayload', 'WF6 parse reads ButtonPayload');
includes(parseCode, '_button_triggered', 'WF6 parse exposes button flag');

const prepareCode = nodeCode(wf6, 'Prepare Reply');
includes(prepareCode, '_should_create_queue_entry', 'WF6 prepare sets queue flag');
includes(prepareCode, '_follow_up_date', 'WF6 prepare passes follow_up_date');
includes(prepareCode, 'TWILIO_CONTENT_FOLLOWUP_BOOKING_CONFIRMED', 'WF6 prepare uses booking confirmed template');
includes(prepareCode, '_content_sid', 'WF6 prepare exposes content template SID');

const wf6NodeNames = wf6.nodes.map((n) => n.name);
for (const required of [
  'Should Create Queue Entry?',
  'Check Existing Visit',
  'Visit Already Exists?',
  'Insert Follow-Up Visit to Queue',
  'Log Queue Creation to Supabase',
  'Log Queue Insert Error to Supabase',
]) {
  assert(wf6NodeNames.includes(required), `WF6 missing node: ${required}`);
}

const insertNode = wf6.nodes.find((n) => n.name === 'Insert Follow-Up Visit to Queue');
assert(insertNode?.onError === 'continueErrorOutput', 'WF6 insert must continue on error');

includes(fs.readFileSync(path.join(root, 'schemas', 'preflight-migrations.sql'), 'utf8'),
  'idx_patient_visits_patient_date_active', 'preflight migration defines active visit unique index');
includes(fs.readFileSync(path.join(root, 'schemas', 'preflight-migrations.sql'), 'utf8'),
  'deduped before idx_patient_visits_patient_date_active', 'preflight dedupes legacy duplicate visits before index');
includes(fs.readFileSync(path.join(root, 'schemas', 'supabase-schema.sql'), 'utf8'),
  'idx_patient_visits_patient_date_active', 'reference schema defines active visit unique index');
includes(fs.readFileSync(path.join(root, '.env.example'), 'utf8'),
  'TWILIO_CONTENT_FOLLOWUP_REMINDER_ADVANCE', '.env.example documents advance reminder template SID');
includes(fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8'),
  'TWILIO_CONTENT_CLINIC_PATIENT_WELCOME', 'docker-compose passes v2 welcome template SID');

assert(classifyInbound({ buttonText: 'Confirm Appointment', buttonPayload: 'confirm_appointment' }) === 'confirmed', 'button confirm payload');
assert(classifyInbound({ buttonText: 'Reschedule', buttonPayload: 'reschedule' }) === 'cancelled', 'button reschedule payload');
assert(classifyInbound({ body: 'Yes, I will come' }) === 'confirmed', 'keyword confirm still works');
assert(classifyInbound({ body: 'No, please cancel' }) === 'cancelled', 'keyword cancel still works');

console.log('[wf6-button-confirmation-static] Passed.');
