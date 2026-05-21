#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const envPath = path.join(repoRoot, '.env');

function parseEnv(filePath) {
  try {
    return Object.fromEntries(
      fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(line => line.trim() && !line.trim().startsWith('#') && line.includes('='))
        .map(line => {
          const i = line.indexOf('=');
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        })
    );
  } catch {
    return {};
  }
}

function isMissing(value) {
  return !value || /^YOUR_|^PLACEHOLDER/i.test(value) || value.includes('YOUR_');
}

const env = { ...parseEnv(envPath), ...process.env };
const errors = [];
const warnings = [];

if (!fs.existsSync(envPath)) {
  errors.push('.env file is missing. Copy .env.example to .env and fill in values.');
}

const required = [
  'N8N_ENCRYPTION_KEY',
  'N8N_OWNER_EMAIL',
  'N8N_OWNER_PASSWORD',
  'WEBHOOK_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_HOST',
  'SUPABASE_DB_USER',
  'SUPABASE_DB_PASSWORD',
  'SUPABASE_DB_NAME',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_FROM',
  'TWILIO_STATUS_CALLBACK_URL',
];

for (const key of required) {
  if (isMissing(env[key])) errors.push(`${key} is missing or still a placeholder.`);
}

const contentSidKeys = [
  'TWILIO_CONTENT_WELCOME',
  'TWILIO_CONTENT_FOLLOW_UP_REMINDER',
  'TWILIO_CONTENT_SAME_DAY_REMINDER',
  'TWILIO_CONTENT_MISSED_RECOVERY',
  'TWILIO_CONTENT_MISSED_NUDGE',
  'TWILIO_CONTENT_HEALTH_CHECK',
  'TWILIO_CONTENT_REACTIVATION',
];

const simplifiedContentSidKeys = [
  'TWILIO_CONTENT_PATIENT_ONBOARDING',
  'TWILIO_CONTENT_HOSPITAL_ONBOARDING',
  'TWILIO_CONTENT_PATIENT_REMINDER',
];

const hasSimplifiedTemplateSet = simplifiedContentSidKeys.some(key => !isMissing(env[key]));

for (const key of contentSidKeys) {
  if (isMissing(env[key])) {
    if (!hasSimplifiedTemplateSet) {
      warnings.push(`${key} is empty. Sandbox/session tests can use Body fallback, but production proactive WhatsApp sends need approved Twilio Content templates.`);
    }
  } else if (!/^HX[a-f0-9]{32}$/i.test(env[key])) {
    warnings.push(`${key} does not look like a Twilio Content SID (expected HX...).`);
  }
}

for (const key of simplifiedContentSidKeys) {
  if (!isMissing(env[key]) && !/^HX[a-f0-9]{32}$/i.test(env[key])) {
    warnings.push(`${key} does not look like a Twilio Content SID (expected HX...).`);
  }
}

const metaKeys = ['WA_PHONE_NUMBER_ID', 'WA_ACCESS_TOKEN', 'WA_WEBHOOK_VERIFY_TOKEN', 'WA_LANGUAGE_CODE'];
for (const key of metaKeys) {
  if (env[key]) errors.push(`${key} is legacy direct-provider config and should be removed from .env for the Twilio-only setup.`);
}

if (env.TWILIO_ACCOUNT_SID && !/^AC[a-f0-9]{32}$/i.test(env.TWILIO_ACCOUNT_SID)) {
  warnings.push('TWILIO_ACCOUNT_SID does not look like a Twilio Account SID (expected AC...).');
}

if (env.TWILIO_WHATSAPP_FROM && !/^whatsapp:\+\d{7,15}$/.test(env.TWILIO_WHATSAPP_FROM)) {
  errors.push('TWILIO_WHATSAPP_FROM must be in the form whatsapp:+14155238886.');
}

for (const key of ['WEBHOOK_URL', 'TWILIO_STATUS_CALLBACK_URL']) {
  if (!env[key]) continue;
  try {
    const url = new URL(env[key]);
    if (!['http:', 'https:'].includes(url.protocol)) errors.push(`${key} must be http(s).`);
    if (key === 'WEBHOOK_URL' && url.protocol !== 'https:' && !/localhost|127\.0\.0\.1/.test(url.hostname)) {
      warnings.push('Production WEBHOOK_URL should be HTTPS.');
    }
  } catch {
    errors.push(`${key} is not a valid URL.`);
  }
}

for (const formPath of ['patient-form/index.html', 'hospital-form/index.html']) {
  const abs = path.join(repoRoot, formPath);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8');
  if (text.includes('YOUR_N8N_WEBHOOK_URL')) {
    warnings.push(`${formPath} still contains YOUR_N8N_WEBHOOK_URL. Replace it before deploying forms.`);
  }
}

if (errors.length) {
  console.error('[validate-env] Failed:');
  for (const e of errors) console.error(`  - ${e}`);
  if (warnings.length) {
    console.warn('\n[validate-env] Warnings:');
    for (const w of warnings) console.warn(`  - ${w}`);
  }
  process.exit(1);
}

if (warnings.length) {
  console.warn('[validate-env] Passed with warnings:');
  for (const w of warnings) console.warn(`  - ${w}`);
} else {
  console.log('[validate-env] Passed.');
}
