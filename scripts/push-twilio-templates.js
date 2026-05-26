#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const registryPath = path.join(root, 'message-templates', 'templates.json');
const outPath = path.join(root, 'build', 'twilio-template-push-results.json');

function loadDotEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index);
    const value = trimmed.slice(index + 1).replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function renderMessage(template) {
  return template.message.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const name = key.trim();
    const index = template.component_parameters?.indexOf(name);
    return index >= 0 ? `{{${index + 1}}}` : `{{${name}}}`;
  });
}

function sampleFor(name) {
  const samples = {
    patient_name: 'Priya',
    clinic_name: 'Mehta Clinic',
    doctor_name: 'Dr. Mehta',
    visit_detail: 'Your visit date is 2026-05-26.',
    hospital_name: 'City Hospital',
    facility_type: 'General Hospital',
    city: 'Bangalore',
    reminder_detail: 'Your follow-up is scheduled for tomorrow at 10:30 AM.',
    follow_up_date: 'Fri, 30 May',
    medicine_name: 'Metformin',
    dosage: '1 tablet',
    timing: 'before breakfast',
    instruction: 'Take with water after food.',
    medicine_summary: 'Paracetamol 500 mg - 1 tablet, twice daily, after food, 5 days',
    follow_up_detail: 'Follow-up date: Fri, 30 May.',
    pdf_url: 'https://example.com/prescriptions/sample.pdf',
  };
  return samples[name] || `Sample ${name}`;
}

async function twilioFetch(url, options = {}) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${body.message || text}`);
  }
  return body;
}

async function main() {
  loadDotEnv();

  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const submitApproval = args.has('--submit-approval');
  const onlyArg = process.argv.find(arg => arg.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map(value => value.trim()).filter(Boolean)) : null;

  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const templates = registry.templates.filter(template => {
    if (!template.twilio_content_env || !Array.isArray(template.component_parameters)) return false;
    if (only && !only.has(template.id)) return false;
    return true;
  });

  const existingByName = new Map();
  if (!dryRun) {
    const list = await twilioFetch('https://content.twilio.com/v1/Content?PageSize=100', { method: 'GET' });
    for (const item of list.contents || []) existingByName.set(item.friendly_name, item);
  }

  const results = [];
  for (const template of templates) {
    const variables = {};
    template.component_parameters.forEach((name, index) => {
      variables[String(index + 1)] = sampleFor(name);
    });

    const payload = {
      friendly_name: template.twilio_friendly_name || template.id,
      language: template.language || 'en',
      variables,
      types: {
        'whatsapp/card': {
          ...Object.assign({
            header_text: template.header_text ? renderMessage({ ...template, message: template.header_text }) : (template.twilio_friendly_name || template.id).replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase()),
            body: renderMessage(template),
            footer: 'vAItalcare support',
          }, Array.isArray(template.actions) && template.actions.length ? { actions: template.actions } : {}),
        },
      },
    };

    if (dryRun) {
      results.push({ id: template.id, status: 'dry_run', payload });
      continue;
    }

    const existing = existingByName.get(payload.friendly_name);
    if (existing) {
      results.push({ id: template.id, env: template.twilio_content_env, status: 'exists', sid: existing.sid, payload });
      console.log(`${template.id}: exists ${existing.sid}`);
      continue;
    }

    const created = await twilioFetch('https://content.twilio.com/v1/Content', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const result = {
      id: template.id,
      env: template.twilio_content_env,
      friendly_name: payload.friendly_name,
      status: 'created',
      sid: created.sid,
      payload,
    };

    if (submitApproval) {
      const approval = await twilioFetch(`https://content.twilio.com/v1/Content/${created.sid}/ApprovalRequests/whatsapp`, {
        method: 'POST',
        body: JSON.stringify({
          name: payload.friendly_name,
          category: template.category || 'UTILITY',
          allow_category_change: true,
        }),
      });
      result.approval_status = approval.status || 'submitted';
      result.approval = approval;
    }

    results.push(result);
    console.log(`${template.id}: created ${created.sid}`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify({ pushed_at: new Date().toISOString(), dry_run: dryRun, submit_approval: submitApproval, results }, null, 2)}\n`);
  console.log(`Wrote ${path.relative(root, outPath)}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
