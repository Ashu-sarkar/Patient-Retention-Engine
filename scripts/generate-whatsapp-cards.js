#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const registryPath = path.join(root, 'message-templates', 'templates.json');
const outDir = path.join(root, 'build');
const outPath = path.join(outDir, 'whatsapp-cards.json');

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

function renderMessage(template) {
  return template.message.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const name = key.trim();
    const index = template.component_parameters?.indexOf(name);
    return index >= 0 ? `{{${index + 1}}}` : `{{${name}}}`;
  });
}

function sampleFor(name) {
  const samples = {
    name: 'Ashutosh Sarkar',
    patient_name: 'Ashutosh Sarkar',
    doctor_name: 'Dr. A. Sharma',
    visit_detail: 'Your visit date is 2026-05-26.',
    clinic_name: 'City Hospital',
    hospital_name: 'City Hospital',
    facility_type: 'General Hospital',
    city: 'Bangalore',
    reminder_detail: 'Your follow-up is scheduled for tomorrow at 10:30 AM.',
    medicine_name: 'Paracetamol 500 mg',
    dosage: '1 tablet',
    timing: 'after breakfast',
    instruction: 'Take with water after food.',
    medicine_summary: 'Paracetamol 500 mg - 1 tablet, twice daily, after food, 5 days',
    follow_up_detail: 'Follow-up date: 2026-05-30.',
    pdf_url: 'https://example.com/prescriptions/sample.pdf',
  };
  return samples[name] || `Sample ${name}`;
}

function cardActions(id) {
  if (id === 'hospital_onboarding') {
    return [
      { type: 'QUICK_REPLY', title: 'Confirm', id: 'confirm' },
      { type: 'QUICK_REPLY', title: 'Edit', id: 'edit' },
    ];
  }
  if (id === 'medicine_reminder') {
    return [
      { type: 'QUICK_REPLY', title: 'Taken', id: 'taken' },
      { type: 'QUICK_REPLY', title: 'Help', id: 'help' },
    ];
  }
  if (id === 'prescription_delivery') {
    return [
      { type: 'QUICK_REPLY', title: 'Received', id: 'received' },
      { type: 'QUICK_REPLY', title: 'Help', id: 'help' },
    ];
  }
  return [
    { type: 'QUICK_REPLY', title: 'Yes', id: 'yes' },
    { type: 'QUICK_REPLY', title: 'Reschedule', id: 'reschedule' },
    { type: 'QUICK_REPLY', title: 'Help', id: 'help' },
  ];
}

function titleFor(id) {
  return id.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

const cards = registry.templates
  .filter(template => Array.isArray(template.component_parameters) && template.twilio_content_env)
  .map(template => {
    const variables = {};
    template.component_parameters.forEach((name, index) => {
      variables[String(index + 1)] = sampleFor(name);
    });

    return {
      id: template.id,
      friendly_name: template.twilio_friendly_name || template.id,
      category: template.category,
      workflow: template.workflow,
      twilio_content_env: template.twilio_content_env,
      variables,
      variable_map: Object.fromEntries(template.component_parameters.map((name, index) => [String(index + 1), name])),
      body: renderMessage(template),
      content_api_payload: {
        friendly_name: template.twilio_friendly_name || template.id,
        language: template.language || 'en',
        variables,
        types: {
          'whatsapp/card': {
            header_text: titleFor(template.twilio_friendly_name || template.id),
            body: renderMessage(template),
            footer: 'vAItalcare support',
            actions: cardActions(template.id),
          },
        },
      },
      notes: template.notes || '',
    };
  });

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify({ generated_at: new Date().toISOString(), cards }, null, 2)}\n`);

console.log(`Generated ${cards.length} WhatsApp card definitions at ${path.relative(root, outPath)}`);
