'use strict';
/**
 * validate-patient-data.js
 *
 * Patient Retention Engine — QR Form Intake Validator
 *
 * Used by WF11 (n8n Code node) to perform server-side validation of the
 * payload sent by the patient registration form.
 *
 * Can also be run as a CLI tool for testing:
 *   node validate-patient-data.js
 *
 * FORM PAYLOAD SCHEMA:
 *   patient_name       — Required text, min 2 chars
 *   phone_number       — Required, exactly 10 digits (no country code)
 *   dob                — Optional, YYYY-MM-DD, must be in the past
 *   sex                — Optional, one of: Male | Female | Other
 *   chief_complaint    — Optional text (min 2 chars if provided); captured when available
 *   symptoms_duration  — Optional visit context
 *   known_allergies    — Optional visit context
 *   current_medicines  — Optional visit context
 *   existing_conditions — Optional visit context
 *   vitals_notes       — Optional staff/vitals notes
 *   hospital_name      — Required, non-empty string
 *   doctor_name        — Required, non-empty string
 *   visit_date         — Required, YYYY-MM-DD, must not be in the future
 */

// ─── Constants ───────────────────────────────────────────────────────────────
const REQUIRED_FIELDS = [
  'patient_name',
  'phone_number',
  'hospital_name',
  'doctor_name',
  'visit_date',
];

const VALID_SEX_VALUES        = ['Male', 'Female', 'Other'];
const PHONE_RE                = /^[0-9]{10}$/;
const DATE_ISO_RE             = /^\d{4}-\d{2}-\d{2}$/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a date string (YYYY-MM-DD) and return a Date at midnight local time.
 * Returns null for empty/falsy values. Throws on bad format.
 */
function parseDate(val, fieldName) {
  if (!val || String(val).trim() === '') return null;
  const s = String(val).trim();
  if (!DATE_ISO_RE.test(s)) {
    throw new Error(`${fieldName}: expected format YYYY-MM-DD, got "${s}"`);
  }
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) {
    throw new Error(`${fieldName}: invalid calendar date "${s}"`);
  }
  return d;
}

/**
 * Validate a raw phone string (10 digits, no country code).
 * Returns { ok, normalised, error }.
 * normalised is the E.164 string (+91XXXXXXXXXX).
 */
function validatePhone(phone) {
  const raw = String(phone || '').trim();
  if (!PHONE_RE.test(raw)) {
    return { ok: false, normalised: null, error: 'phone_number: must be exactly 10 digits (no +91)' };
  }
  return { ok: true, normalised: '+91' + raw, error: null };
}

// ─── Core Validator ──────────────────────────────────────────────────────────

/**
 * Validate a single form submission payload.
 *
 * @param {object} row  — raw form payload
 * @returns {{ valid: boolean, errors: string[], normalised: object|null }}
 */
function validateIntakeRow(row) {
  const errors = [];
  const today  = new Date();
  today.setHours(0, 0, 0, 0);

  // ── Required fields ────────────────────────────────────────
  for (const field of REQUIRED_FIELDS) {
    if (!row[field] || String(row[field]).trim() === '') {
      errors.push(`${field}: required`);
    }
  }

  // ── patient_name ───────────────────────────────────────────
  const name = String(row.patient_name || '').trim();
  if (name && name.length < 2) {
    errors.push('patient_name: minimum 2 characters');
  }

  // ── chief_complaint ───────────────────────────────────────
  const chiefComplaint = String(row.chief_complaint || '').trim();
  if (chiefComplaint && chiefComplaint.length < 2) {
    errors.push('chief_complaint: minimum 2 characters');
  }

  // ── phone_number ───────────────────────────────────────────
  const phoneResult = validatePhone(row.phone_number);
  if (!phoneResult.ok) errors.push(phoneResult.error);

  // ── sex (optional) ─────────────────────────────────────────
  const sex = String(row.sex || '').trim();
  if (sex && !VALID_SEX_VALUES.includes(sex)) {
    errors.push(`sex: must be one of ${VALID_SEX_VALUES.join(', ')}`);
  }

  // ── visit_date ─────────────────────────────────────────────
  let visitDate = null;
  try {
    visitDate = parseDate(row.visit_date, 'visit_date');
    if (visitDate && visitDate > today) {
      errors.push('visit_date: cannot be in the future');
    }
  } catch (e) {
    errors.push(e.message);
  }

  // ── dob (optional) ─────────────────────────────────────────
  try {
    const dob = parseDate(row.dob, 'dob');
    if (dob && dob >= today) {
      errors.push('dob: must be a past date');
    }
  } catch (e) {
    errors.push(e.message);
  }

  if (errors.length > 0) {
    return { valid: false, errors, normalised: null };
  }

  // ── Build normalised payload ───────────────────────────────
  const normalised = {
    name:               name,
    phone:              phoneResult.normalised,
    dob:                row.dob  ? String(row.dob).trim()  : null,
    sex:                sex      || null,
    clinic_name:        String(row.hospital_name).trim(),
    doctor_name:        String(row.doctor_name).trim(),
    visit_date:         String(row.visit_date).trim(),
    chief_complaint:    chiefComplaint,
    symptoms_duration:  row.symptoms_duration ? String(row.symptoms_duration).trim() : null,
    known_allergies:    row.known_allergies ? String(row.known_allergies).trim() : null,
    current_medicines:  row.current_medicines ? String(row.current_medicines).trim() : null,
    existing_conditions: row.existing_conditions ? String(row.existing_conditions).trim() : null,
    vitals_notes:       row.vitals_notes ? String(row.vitals_notes).trim() : null,
    follow_up_required: 'No',
    follow_up_date:     null,
  };

  return { valid: true, errors: [], normalised };
}

// ─── Exports (used by n8n Code node via require/inline paste) ────────────────
if (typeof module !== 'undefined') {
  module.exports = { validateIntakeRow, validatePhone, parseDate };
}

// ─── CLI Self-test ───────────────────────────────────────────────────────────
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('validate-patient-data.js')) {
  const tests = [
    {
      label: 'VALID — standard intake',
      row: {
        patient_name: 'Ramesh Kumar', phone_number: '9876543210',
        dob: '1990-05-15', sex: 'Male',
        chief_complaint: 'Fever and cough',
        symptoms_duration: 'Two days',
        known_allergies: 'None',
        hospital_name: 'City Hospital', doctor_name: 'Dr. Sharma',
        visit_date: new Date().toLocaleDateString('en-CA'),
      },
    },
    {
      label: 'VALID — no dob/sex',
      row: {
        patient_name: 'Priya', phone_number: '9000000001',
        dob: '', sex: '',
        chief_complaint: 'Routine consultation',
        hospital_name: 'Metro Clinic', doctor_name: 'Dr. Mehta',
        visit_date: new Date().toLocaleDateString('en-CA'),
      },
    },
    {
      label: 'INVALID — short name, bad phone, future visit',
      row: {
        patient_name: 'A', phone_number: '98765',
        dob: '', sex: 'Unknown',
        chief_complaint: '',
        hospital_name: 'City Hospital', doctor_name: 'Dr. Patel',
        visit_date: '2099-01-01',
      },
    },
  ];

  tests.forEach(({ label, row }) => {
    const result = validateIntakeRow(row);
    console.log(`\n[${label}]`);
    console.log('  valid:', result.valid);
    if (!result.valid) console.log('  errors:', result.errors);
    else console.log('  normalised:', result.normalised);
  });
}
