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

function extractSupabaseProjectRef(supabaseUrl) {
  try {
    const url = new URL(String(supabaseUrl || '').trim());
    const match = url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return match ? match[1] : '';
  } catch {
    return '';
  }
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
  'INTERNAL_WEBHOOK_SECRET',
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
  'N8N_PRESCRIPTION_DELIVERY_URL',
];

for (const key of required) {
  if (isMissing(env[key])) errors.push(`${key} is missing or still a placeholder.`);
}

const contentSidKeys = [
  'TWILIO_CONTENT_FOLLOWUP_REMINDER_ADVANCE',
  'TWILIO_CONTENT_FOLLOWUP_REMINDER_DAY_OF',
  'TWILIO_CONTENT_PATIENT_HEALTH_CHECK',
  'TWILIO_CONTENT_MISSED_FOLLOWUP_RECOVERY_1',
  'TWILIO_CONTENT_MISSED_FOLLOWUP_RECOVERY_2',
  'TWILIO_CONTENT_FOLLOWUP_BOOKING_CONFIRMED',
  'TWILIO_CONTENT_FOLLOWUP_RESCHEDULED_CONFIRMED',
];

const legacyContentSidKeys = [
  'TWILIO_CONTENT_WELCOME',
  'TWILIO_CONTENT_FOLLOW_UP_REMINDER',
  'TWILIO_CONTENT_FOLLOWUP_CONFIRMATION',
  'TWILIO_CONTENT_SAME_DAY_REMINDER',
  'TWILIO_CONTENT_MISSED_RECOVERY',
  'TWILIO_CONTENT_MISSED_NUDGE',
  'TWILIO_CONTENT_HEALTH_CHECK',
  'TWILIO_CONTENT_REACTIVATION',
];

const simplifiedContentSidKeys = [
  'TWILIO_CONTENT_CLINIC_PATIENT_WELCOME',
  'TWILIO_CONTENT_PATIENT_ONBOARDING',
  'TWILIO_CONTENT_HOSPITAL_ONBOARDING',
  'TWILIO_CONTENT_PATIENT_REMINDER',
  'TWILIO_CONTENT_MEDICINE_REMINDER',
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

const hasPatientOnboardingTemplate =
  !isMissing(env.TWILIO_CONTENT_CLINIC_PATIENT_WELCOME) ||
  !isMissing(env.TWILIO_CONTENT_PATIENT_ONBOARDING) ||
  !isMissing(env.TWILIO_CONTENT_WELCOME);

if (!hasPatientOnboardingTemplate) {
  errors.push('TWILIO_CONTENT_CLINIC_PATIENT_WELCOME, TWILIO_CONTENT_PATIENT_ONBOARDING, or TWILIO_CONTENT_WELCOME is required for patient onboarding WhatsApp templates.');
}

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

for (const key of legacyContentSidKeys) {
  if (!isMissing(env[key])) {
    warnings.push(`${key} is a legacy v1 template SID. Prefer the v2 TWILIO_CONTENT_* keys documented in docs/whatsapp-templates-v2-logic.md.`);
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

if (env.INTERNAL_WEBHOOK_SECRET && env.INTERNAL_WEBHOOK_SECRET.length < 32) {
  errors.push('INTERNAL_WEBHOOK_SECRET must be at least 32 characters.');
}

if (env.N8N_ENCRYPTION_KEY && env.INTERNAL_WEBHOOK_SECRET && env.N8N_ENCRYPTION_KEY === env.INTERNAL_WEBHOOK_SECRET) {
  errors.push('INTERNAL_WEBHOOK_SECRET must be different from N8N_ENCRYPTION_KEY.');
}

const supabaseProjectRef = extractSupabaseProjectRef(env.SUPABASE_URL);
if (String(env.SUPABASE_DB_HOST || '').includes('pooler.supabase.com')) {
  if (env.SUPABASE_DB_USER === 'postgres') {
    errors.push(
      'SUPABASE_DB_USER is set to "postgres", but Supabase pooler requires "postgres.<project-ref>". ' +
      (supabaseProjectRef ? `Use SUPABASE_DB_USER=postgres.${supabaseProjectRef}.` : 'Use the exact user from Supabase Dashboard → Connect → Session pooler.')
    );
  } else if (supabaseProjectRef && env.SUPABASE_DB_USER !== `postgres.${supabaseProjectRef}`) {
    errors.push(`SUPABASE_DB_USER must be postgres.${supabaseProjectRef} for this SUPABASE_URL and pooler host.`);
  }
}

for (const key of ['WEBHOOK_URL', 'TWILIO_STATUS_CALLBACK_URL', 'N8N_PRESCRIPTION_DELIVERY_URL', 'DOCTOR_DASHBOARD_ORIGIN']) {
  if (!env[key]) continue;
  try {
    const url = new URL(env[key]);
    if (!['http:', 'https:'].includes(url.protocol)) errors.push(`${key} must be http(s).`);
    if (['WEBHOOK_URL', 'TWILIO_STATUS_CALLBACK_URL', 'N8N_PRESCRIPTION_DELIVERY_URL', 'DOCTOR_DASHBOARD_ORIGIN'].includes(key) &&
        url.protocol !== 'https:' && !/localhost|127\.0\.0\.1/.test(url.hostname)) {
      warnings.push(`Production ${key} should be HTTPS.`);
    }
  } catch {
    errors.push(`${key} is not a valid URL.`);
  }
}

if (!isMissing(env.SUPABASE_SERVICE_ROLE_KEY) && !String(env.SUPABASE_SERVICE_ROLE_KEY).trim().startsWith('eyJ')) {
  warnings.push('SUPABASE_SERVICE_ROLE_KEY does not look like a JWT — PostgREST calls from scripts may fail. Regenerate it in Supabase Dashboard → Settings → API.');
}

if (String(env.TWILIO_VALIDATE_WEBHOOK_SIGNATURE || '').toLowerCase() === 'true') {
  const webhookUrl = env.WEBHOOK_URL || '';
  if (!webhookUrl.startsWith('https://')) {
    errors.push('TWILIO_VALIDATE_WEBHOOK_SIGNATURE=true requires production WEBHOOK_URL to be HTTPS and exactly match Twilio webhook configuration.');
  }
}

if (!isMissing(env.SEND_SMS_HOOK_SECRETS) || !isMissing(env.TWILIO_CONTENT_DOCTOR_OTP)) {
  warnings.push('SEND_SMS_HOOK_SECRETS/TWILIO_CONTENT_DOCTOR_OTP are legacy doctor OTP settings. The dashboard now uses onboarding-created username/password auth.');
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
