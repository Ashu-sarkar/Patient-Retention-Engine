#!/usr/bin/env node

/**
 * Patient Intake Data Validation Utility
 *
 * Validates the 13-column daily intake sheet format used by the
 * Patient Retention Engine (WF9/WF10 architecture).
 *
 * Usage (CLI):
 *   node validate-patient-data.js path/to/intake-rows.json
 *   node validate-patient-data.js path/to/intake-rows.json --fix
 *
 * Usage (n8n Code node — inline, paste validateIntakeRow function):
 *   const result = validateIntakeRow(rowObject);
 *
 * Input JSON format (array of objects matching the 13-column intake sheet):
 *   [
 *     {
 *       "hospital_name": "City Hospital",
 *       "doctor_name": "Dr. Sharma",
 *       "patient_name": "Priya Sharma",
 *       "dob": "15/06/1990",
 *       "sex": "Female",
 *       "phone_number": "9876543210",
 *       "visit_date": "15/04/2026",
 *       "follow_up_required": "Yes",
 *       "follow_up_date": "22/04/2026"
 *     }
 *   ]
 *
 * COLUMN SCHEMA (13 columns — strict order):
 *   A: id               — Auto (WF10 fills this; leave blank in input)
 *   B: hospital_name    — Required dropdown
 *   C: doctor_name      — Required dropdown
 *   D: patient_name     — Required text (min 2 chars)
 *   E: dob              — Optional date (DD/MM/YYYY), must be in past
 *   F: sex              — Optional dropdown (Male/Female/Other)
 *   G: phone_number     — Required, 10 digits, no country code
 *   H: visit_date       — Required date (DD/MM/YYYY), must not be future
 *   I: follow_up_required — Required dropdown (Yes/No)
 *   J: follow_up_date   — Conditional (required if follow_up_required=Yes), must be > visit_date
 *   K: status           — Auto (WF10 fills this)
 *   L: created_at       — Auto (WF10 fills this)
 *   M: updated_at       — Auto (WF10 fills this)
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['hospital_name', 'doctor_name', 'patient_name', 'phone_number', 'visit_date', 'follow_up_required'];
const VALID_SEX_VALUES = ['Male', 'Female', 'Other'];
const VALID_FOLLOW_UP_VALUES = ['Yes', 'No'];
const PHONE_REGEX = /^[0-9]{10}$/;
const DATE_DD_MM_YYYY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const DATE_YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

// ─── Core Validators ──────────────────────────────────────────────────────────

/**
 * Parses a date string in DD/MM/YYYY or YYYY-MM-DD format.
 * Returns { valid, iso, error } where iso is "YYYY-MM-DD" or null.
 */
function parseDate(val, fieldName) {
  if (!val || String(val).trim() === '') {
    return { valid: true, iso: null, error: null };
  }

  const s = String(val).trim();
  let d;

  if (DATE_DD_MM_YYYY.test(s)) {
    const [, dd, mm, yyyy] = s.match(DATE_DD_MM_YYYY);
    d = new Date(`${yyyy}-${mm}-${dd}`);
  } else if (DATE_YYYY_MM_DD.test(s)) {
    d = new Date(s);
  } else {
    d = new Date(s);
  }

  if (isNaN(d.getTime())) {
    return {
      valid: false,
      iso: null,
      error: `${fieldName} "${val}" is not a valid date. Use DD/MM/YYYY format (e.g. 15/04/2026)`
    };
  }

  const iso = d.toISOString().split('T')[0]; // YYYY-MM-DD
  return { valid: true, iso, error: null };
}

/**
 * Validates a phone number string.
 * Accepts exactly 10 digits (no country code, no spaces, no dashes).
 * Returns { valid, normalised, e164, error }
 *   normalised: "9876543210"
 *   e164:       "+919876543210" (assumes India +91)
 */
function validatePhone(phone) {
  if (!phone || typeof phone !== 'string' && typeof phone !== 'number') {
    return { valid: false, normalised: null, e164: null, error: 'phone_number is missing or not a string' };
  }

  const stripped = String(phone).replace(/[\s\-().+]/g, '');

  if (!PHONE_REGEX.test(stripped)) {
    return {
      valid: false,
      normalised: null,
      e164: null,
      error: `phone_number "${phone}" must be exactly 10 digits with no spaces, dashes, or country code (e.g. 9876543210)`
    };
  }

  return { valid: true, normalised: stripped, e164: '+91' + stripped, error: null };
}

/**
 * Validates a single intake row.
 * Returns:
 *   {
 *     valid: boolean,
 *     errors: string[],         // blocking issues — row will be flagged INVALID
 *     warnings: string[],       // non-blocking — row will be processed but noted
 *     normalised: object        // row with normalised/mapped values
 *   }
 */
function validateIntakeRow(row, rowIndex = null) {
  const errors = [];
  const warnings = [];
  const normalised = { ...row };
  const label = rowIndex !== null ? `Row ${rowIndex}: ` : '';
  const today = new Date();
  const todayISO = today.toISOString().split('T')[0];

  // ── Required field presence ───────────────────────────────────────────────
  for (const field of REQUIRED_FIELDS) {
    const val = row[field];
    if (!val || String(val).trim() === '') {
      errors.push(`${label}Missing required field: "${field}"`);
    }
  }

  // ── patient_name length ───────────────────────────────────────────────────
  if (row.patient_name && String(row.patient_name).trim().length < 2) {
    errors.push(`${label}patient_name must be at least 2 characters`);
  }
  if (row.patient_name && String(row.patient_name).trim().length > 100) {
    warnings.push(`${label}patient_name is unusually long — check for data entry error`);
  }

  // ── Phone validation ──────────────────────────────────────────────────────
  if (row.phone_number) {
    const phoneResult = validatePhone(row.phone_number);
    if (!phoneResult.valid) {
      errors.push(`${label}${phoneResult.error}`);
    } else {
      normalised.phone_number = phoneResult.normalised;
      normalised._e164_phone = phoneResult.e164; // normalised E.164 for Supabase
    }
  }

  // ── sex validation ────────────────────────────────────────────────────────
  if (row.sex && String(row.sex).trim() !== '') {
    const sexVal = String(row.sex).trim();
    if (!VALID_SEX_VALUES.includes(sexVal)) {
      warnings.push(`${label}sex "${sexVal}" is not valid. Use: ${VALID_SEX_VALUES.join(', ')}`);
      normalised.sex = null;
    }
  }

  // ── follow_up_required validation ────────────────────────────────────────
  if (row.follow_up_required) {
    const fuReq = String(row.follow_up_required).trim();
    if (!VALID_FOLLOW_UP_VALUES.includes(fuReq)) {
      errors.push(`${label}follow_up_required "${fuReq}" is not valid. Use "Yes" or "No"`);
    } else {
      normalised.follow_up_required = fuReq;
    }
  }

  // ── visit_date validation ─────────────────────────────────────────────────
  let visitISO = null;
  if (row.visit_date) {
    const vd = parseDate(row.visit_date, 'visit_date');
    if (!vd.valid) {
      errors.push(`${label}${vd.error}`);
    } else if (vd.iso) {
      if (vd.iso > todayISO) {
        errors.push(`${label}visit_date "${row.visit_date}" cannot be in the future (today is ${todayISO})`);
      } else {
        visitISO = vd.iso;
        normalised.visit_date = visitISO;
      }
    }
  }

  // ── dob validation ────────────────────────────────────────────────────────
  if (row.dob && String(row.dob).trim() !== '') {
    const dobResult = parseDate(row.dob, 'dob');
    if (!dobResult.valid) {
      warnings.push(`${label}${dobResult.error}`);
    } else if (dobResult.iso && dobResult.iso >= todayISO) {
      errors.push(`${label}dob "${row.dob}" must be in the past`);
    } else {
      normalised.dob = dobResult.iso;
    }
  }

  // ── follow_up_date conditional logic ─────────────────────────────────────
  const fuRequired = String(row.follow_up_required || '').trim();
  let followUpISO = null;

  if (row.follow_up_date && String(row.follow_up_date).trim() !== '') {
    const fud = parseDate(row.follow_up_date, 'follow_up_date');
    if (!fud.valid) {
      errors.push(`${label}${fud.error}`);
    } else {
      followUpISO = fud.iso;
      normalised.follow_up_date = followUpISO;
    }
  }

  if (fuRequired === 'Yes') {
    if (!followUpISO) {
      errors.push(`${label}follow_up_date is required when follow_up_required = "Yes"`);
    } else if (visitISO && followUpISO <= visitISO) {
      errors.push(`${label}follow_up_date (${followUpISO}) must be strictly after visit_date (${visitISO})`);
    }
  } else if (fuRequired === 'No') {
    if (followUpISO) {
      warnings.push(`${label}follow_up_date is set but follow_up_required = "No" — follow_up_date will be cleared`);
      normalised.follow_up_date = null;
    }
  }

  // ── Auto-filled columns should be blank in input ──────────────────────────
  const autoColumns = ['id', 'status', 'created_at', 'updated_at'];
  for (const col of autoColumns) {
    if (row[col] && String(row[col]).trim() !== '') {
      warnings.push(`${label}Column "${col}" is auto-filled by the system — the value "${row[col]}" will be overwritten`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalised
  };
}

/**
 * Validates a batch of intake rows.
 * Also checks for duplicate phone_number values within the batch.
 * Returns:
 *   {
 *     summary: { total, valid, invalid, withWarnings, duplicates },
 *     results: Array<{ rowIndex, row, valid, errors, warnings, normalised }>,
 *     duplicates: Array<{ phone, rows: number[] }>
 *   }
 */
function validateBatch(rows) {
  if (!Array.isArray(rows)) {
    return {
      summary: { total: 0, valid: 0, invalid: 0, withWarnings: 0, duplicates: 0 },
      results: [],
      duplicates: [],
      error: 'Input must be an array of intake row objects'
    };
  }

  const results = [];
  const phoneMap = {};

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowIndex = i + 2; // row 1 = header in Google Sheets

    // Skip completely empty rows
    const hasAnyData = Object.values(row).some(v => v !== undefined && v !== null && String(v).trim() !== '');
    if (!hasAnyData) continue;

    const result = validateIntakeRow(row, rowIndex);
    results.push({ rowIndex, row, ...result });

    // Track phone for duplicate detection
    if (row.phone_number) {
      const stripped = String(row.phone_number).replace(/[\s\-().+]/g, '');
      if (!phoneMap[stripped]) phoneMap[stripped] = [];
      phoneMap[stripped].push(rowIndex);
    }
  }

  // Find duplicates
  const duplicates = Object.entries(phoneMap)
    .filter(([, rows]) => rows.length > 1)
    .map(([phone, rows]) => ({ phone, rows }));

  // Attach duplicate warnings to affected rows
  if (duplicates.length > 0) {
    const dupRowSet = new Set(duplicates.flatMap(d => d.rows));
    for (const result of results) {
      if (dupRowSet.has(result.rowIndex)) {
        const dup = duplicates.find(d => d.rows.includes(result.rowIndex));
        result.warnings.push(
          `Duplicate phone_number ${dup.phone} found in rows: ${dup.rows.join(', ')} — only the first occurrence will be synced`
        );
      }
    }
  }

  const summary = {
    total: results.length,
    valid: results.filter(r => r.valid && r.warnings.length === 0).length,
    invalid: results.filter(r => !r.valid).length,
    withWarnings: results.filter(r => r.valid && r.warnings.length > 0).length,
    duplicates: duplicates.length
  };

  return { summary, results, duplicates };
}

// ─── CLI Report ────────────────────────────────────────────────────────────────

function printReport(batchResult) {
  const { summary, results, duplicates } = batchResult;

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║     PATIENT INTAKE DATA VALIDATION REPORT       ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  console.log('SUMMARY');
  console.log('-------');
  console.log(`  Total records:    ${summary.total}`);
  console.log(`  Valid (clean):    ${summary.valid}`);
  console.log(`  Has warnings:     ${summary.withWarnings}`);
  console.log(`  Invalid (errors): ${summary.invalid}`);
  console.log(`  Duplicate phones: ${summary.duplicates}`);
  console.log('');

  console.log('COLUMN REFERENCE (13-column intake schema)');
  console.log('-------------------------------------------');
  console.log('  Staff fills:  B(hospital_name), C(doctor_name), D(patient_name),');
  console.log('                E(dob), F(sex), G(phone_number), H(visit_date),');
  console.log('                I(follow_up_required), J(follow_up_date)');
  console.log('  Auto-filled:  A(id), K(status), L(created_at), M(updated_at)');
  console.log('');

  if (duplicates.length > 0) {
    console.log('DUPLICATE PHONE NUMBERS');
    console.log('-----------------------');
    for (const dup of duplicates) {
      console.log(`  Phone ${dup.phone} appears in rows: ${dup.rows.join(', ')}`);
    }
    console.log('');
  }

  const invalidResults = results.filter(r => !r.valid);
  if (invalidResults.length > 0) {
    console.log('ERRORS (rows that will be flagged INVALID in the sheet)');
    console.log('-------------------------------------------------------');
    for (const r of invalidResults) {
      const name = r.row.patient_name || '(no name)';
      const phone = r.row.phone_number || '(no phone)';
      console.log(`  Row ${r.rowIndex}: ${name} | Phone: ${phone}`);
      for (const err of r.errors) {
        console.log(`    ✗ ${err}`);
      }
    }
    console.log('');
  }

  const warnResults = results.filter(r => r.valid && r.warnings.length > 0);
  if (warnResults.length > 0) {
    console.log('WARNINGS (rows that will be synced, but may have issues)');
    console.log('---------------------------------------------------------');
    for (const r of warnResults) {
      const name = r.row.patient_name || '(no name)';
      console.log(`  Row ${r.rowIndex}: ${name}`);
      for (const warn of r.warnings) {
        console.log(`    ⚠ ${warn}`);
      }
    }
    console.log('');
  }

  if (summary.invalid === 0 && summary.duplicates === 0) {
    console.log('✅ All records are valid and ready to sync to Supabase!\n');
  } else {
    console.log(`❌ Found ${summary.invalid} invalid record(s) and ${summary.duplicates} duplicate phone(s).`);
    console.log('Fix these issues in the intake sheet before they will sync to Supabase.\n');
  }
}

// ─── CLI Entry Point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const filePath = args[0];
  const shouldFix = args.includes('--fix');

  if (!filePath) {
    console.error('Usage: node validate-patient-data.js <path-to-intake-rows.json> [--fix]');
    console.error('');
    console.error('  --fix    Output a normalised version of valid records (intake-rows-fixed.json)');
    console.error('');
    console.error('Input JSON: array of objects with keys matching the 13-column intake sheet');
    process.exit(1);
  }

  const fs = require('fs');
  const path = require('path');

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error(`Cannot read file: ${filePath}\n${e.message}`);
    process.exit(1);
  }

  let rows;
  try {
    rows = JSON.parse(raw);
  } catch (e) {
    console.error(`Invalid JSON in file: ${filePath}\n${e.message}`);
    process.exit(1);
  }

  const result = validateBatch(rows);
  printReport(result);

  if (shouldFix) {
    const fixedRows = result.results
      .filter(r => r.valid)
      .map(r => r.normalised);

    const outPath = path.join(
      path.dirname(filePath),
      path.basename(filePath, '.json') + '-fixed.json'
    );
    fs.writeFileSync(outPath, JSON.stringify(fixedRows, null, 2));
    console.log(`Fixed records written to: ${outPath}`);
    console.log(`(${fixedRows.length} valid records, ${result.summary.invalid} invalid records excluded)\n`);
  }

  process.exit(result.summary.invalid > 0 ? 1 : 0);
}

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = { validateIntakeRow, validateBatch, validatePhone, parseDate };
