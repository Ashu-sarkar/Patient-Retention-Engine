#!/usr/bin/env node

/**
 * Patient Data Validation Utility
 *
 * Usage (CLI):
 *   node validate-patient-data.js path/to/patients.json
 *   node validate-patient-data.js path/to/patients.json --fix
 *
 * Usage (n8n Code node):
 *   const { validatePatient, validateBatch } = require('./validate-patient-data');
 *   const result = validatePatient(patientObject);
 *
 * Input JSON format (array of patient objects matching Patients sheet schema):
 *   [
 *     {
 *       "name": "Priya Sharma",
 *       "phone": "+919876543210",
 *       "doctor_name": "Dr. Mehta",
 *       "clinic_name": "HealthPlus",
 *       "visit_date": "2024-01-15",
 *       "follow_up_date": "2024-01-22",
 *       "status": "pending"
 *     }
 *   ]
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['name', 'phone'];
const RECOMMENDED_FIELDS = ['doctor_name', 'clinic_name', 'visit_date', 'follow_up_date'];
const VALID_STATUSES = ['pending', 'completed', 'missed', 'inactive', 'data_error'];
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

// ─── Core Validators ──────────────────────────────────────────────────────────

/**
 * Validates a phone number string.
 * Accepts E.164 format: +[country_code][number], no spaces, no dashes.
 * Returns { valid: boolean, normalised: string|null, error: string|null }
 */
function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return { valid: false, normalised: null, error: 'Phone is missing or not a string' };
  }

  // Strip common formatting characters before checking
  const stripped = phone.replace(/[\s\-().]/g, '');

  if (!E164_REGEX.test(stripped)) {
    return {
      valid: false,
      normalised: null,
      error: `Invalid phone format "${phone}". Expected E.164 format: +[country_code][number] (e.g. +919876543210)`
    };
  }

  return { valid: true, normalised: stripped, error: null };
}

/**
 * Validates a date string.
 * Accepts YYYY-MM-DD format only.
 * Returns { valid: boolean, error: string|null }
 */
function validateDate(dateStr, fieldName) {
  if (!dateStr || dateStr.trim() === '') {
    return { valid: true, error: null }; // Dates are optional — blank is OK
  }

  if (!DATE_REGEX.test(dateStr)) {
    return {
      valid: false,
      error: `${fieldName} "${dateStr}" is not in YYYY-MM-DD format`
    };
  }

  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    return {
      valid: false,
      error: `${fieldName} "${dateStr}" is not a valid calendar date`
    };
  }

  return { valid: true, error: null };
}

/**
 * Validates a single patient object.
 * Returns:
 *   {
 *     valid: boolean,
 *     errors: string[],         // blocking issues — record will not be processed
 *     warnings: string[],       // non-blocking issues — record will be processed but may behave unexpectedly
 *     normalised: object        // patient object with normalised values applied
 *   }
 */
function validatePatient(patient, rowIndex = null) {
  const errors = [];
  const warnings = [];
  const normalised = { ...patient };
  const rowLabel = rowIndex !== null ? `Row ${rowIndex}: ` : '';

  // ── Required field checks ────────────────────────────────────────────────

  for (const field of REQUIRED_FIELDS) {
    if (!patient[field] || String(patient[field]).trim() === '') {
      errors.push(`${rowLabel}Missing required field: "${field}"`);
    }
  }

  // ── Phone validation ─────────────────────────────────────────────────────

  if (patient.phone) {
    const phoneResult = validatePhone(patient.phone);
    if (!phoneResult.valid) {
      errors.push(`${rowLabel}${phoneResult.error}`);
    } else {
      normalised.phone = phoneResult.normalised; // normalise formatting
    }
  }

  // ── Date validations ─────────────────────────────────────────────────────

  if (patient.visit_date) {
    const vd = validateDate(patient.visit_date, 'visit_date');
    if (!vd.valid) errors.push(`${rowLabel}${vd.error}`);
  }

  if (patient.follow_up_date) {
    const fd = validateDate(patient.follow_up_date, 'follow_up_date');
    if (!fd.valid) errors.push(`${rowLabel}${fd.error}`);
  }

  // ── Date logic: follow_up_date must be after visit_date ──────────────────

  if (patient.visit_date && patient.follow_up_date) {
    const visitDate = new Date(patient.visit_date);
    const followUpDate = new Date(patient.follow_up_date);
    if (!isNaN(visitDate.getTime()) && !isNaN(followUpDate.getTime())) {
      if (followUpDate < visitDate) {
        errors.push(`${rowLabel}follow_up_date (${patient.follow_up_date}) cannot be before visit_date (${patient.visit_date})`);
      }
    }
  }

  // ── Status validation ────────────────────────────────────────────────────

  if (patient.status && !VALID_STATUSES.includes(patient.status)) {
    warnings.push(`${rowLabel}Unknown status "${patient.status}". Valid values: ${VALID_STATUSES.join(', ')}`);
    normalised.status = 'pending'; // default to pending if invalid
  }

  if (!patient.status || patient.status.trim() === '') {
    normalised.status = 'pending'; // default
  }

  // ── Recommended field warnings ───────────────────────────────────────────

  for (const field of RECOMMENDED_FIELDS) {
    if (!patient[field] || String(patient[field]).trim() === '') {
      warnings.push(`${rowLabel}Recommended field "${field}" is empty — messages will use defaults`);
    }
  }

  // ── Name length check ────────────────────────────────────────────────────

  if (patient.name && patient.name.length > 100) {
    warnings.push(`${rowLabel}Patient name is unusually long (${patient.name.length} chars) — check for data entry error`);
  }

  // ── Message count normalisation ──────────────────────────────────────────

  if (patient.message_count === undefined || patient.message_count === '') {
    normalised.message_count = 0;
  } else {
    const mc = parseInt(patient.message_count);
    if (isNaN(mc)) {
      warnings.push(`${rowLabel}message_count "${patient.message_count}" is not a number — resetting to 0`);
      normalised.message_count = 0;
    } else {
      normalised.message_count = mc;
    }
  }

  // ── Boolean field normalisation ──────────────────────────────────────────

  for (const boolField of ['health_check_sent', 'reactivation_sent']) {
    const val = patient[boolField];
    if (val === undefined || val === '') {
      normalised[boolField] = false;
    } else if (val === 'TRUE' || val === true || val === '1') {
      normalised[boolField] = true;
    } else if (val === 'FALSE' || val === false || val === '0') {
      normalised[boolField] = false;
    } else {
      warnings.push(`${rowLabel}${boolField} has unexpected value "${val}" — treating as false`);
      normalised[boolField] = false;
    }
  }

  // ── Response status normalisation ────────────────────────────────────────

  const validResponseStatuses = ['none', 'responded', 'confirmed', 'cancelled'];
  if (!patient.response_status || !validResponseStatuses.includes(patient.response_status)) {
    normalised.response_status = 'none';
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalised
  };
}

/**
 * Validates a batch of patient records.
 * Also checks for duplicate phone numbers within the batch.
 * Returns:
 *   {
 *     summary: { total, valid, invalid, withWarnings, duplicates },
 *     results: Array<{ rowIndex, patient, valid, errors, warnings, normalised }>,
 *     duplicates: Array<{ phone, rows: number[] }>
 *   }
 */
function validateBatch(patients) {
  if (!Array.isArray(patients)) {
    return {
      summary: { total: 0, valid: 0, invalid: 0, withWarnings: 0, duplicates: 0 },
      results: [],
      duplicates: [],
      error: 'Input must be an array of patient objects'
    };
  }

  const results = [];
  const phoneMap = {}; // phone → [rowIndexes]

  for (let i = 0; i < patients.length; i++) {
    const patient = patients[i];
    const rowIndex = i + 2; // +2 because row 1 is headers in Google Sheets

    const result = validatePatient(patient, rowIndex);
    results.push({ rowIndex, patient, ...result });

    // Track phones for duplicate detection
    if (patient.phone) {
      const normPhone = validatePhone(patient.phone).normalised || patient.phone;
      if (!phoneMap[normPhone]) phoneMap[normPhone] = [];
      phoneMap[normPhone].push(rowIndex);
    }
  }

  // Find duplicates
  const duplicates = Object.entries(phoneMap)
    .filter(([, rows]) => rows.length > 1)
    .map(([phone, rows]) => ({ phone, rows }));

  // Add duplicate warnings to affected results
  if (duplicates.length > 0) {
    const dupRowSet = new Set(duplicates.flatMap(d => d.rows));
    for (const result of results) {
      if (dupRowSet.has(result.rowIndex)) {
        const dup = duplicates.find(d => d.rows.includes(result.rowIndex));
        result.warnings.push(
          `Duplicate phone number ${dup.phone} found in rows: ${dup.rows.join(', ')}`
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

// ─── CLI Interface ─────────────────────────────────────────────────────────────

function printReport(batchResult) {
  const { summary, results, duplicates } = batchResult;

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║         PATIENT DATA VALIDATION REPORT          ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  console.log('SUMMARY');
  console.log('-------');
  console.log(`  Total records:    ${summary.total}`);
  console.log(`  Valid (clean):    ${summary.valid}`);
  console.log(`  Has warnings:     ${summary.withWarnings}`);
  console.log(`  Invalid (errors): ${summary.invalid}`);
  console.log(`  Duplicate phones: ${summary.duplicates}`);
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
    console.log('ERRORS (records that will be skipped)');
    console.log('--------------------------------------');
    for (const r of invalidResults) {
      const name = r.patient.name || '(no name)';
      console.log(`  Row ${r.rowIndex}: ${name}`);
      for (const err of r.errors) {
        console.log(`    ✗ ${err}`);
      }
    }
    console.log('');
  }

  const warnResults = results.filter(r => r.valid && r.warnings.length > 0);
  if (warnResults.length > 0) {
    console.log('WARNINGS (records that will be processed, but may have issues)');
    console.log('----------------------------------------------------------------');
    for (const r of warnResults) {
      const name = r.patient.name || '(no name)';
      console.log(`  Row ${r.rowIndex}: ${name}`);
      for (const warn of r.warnings) {
        console.log(`    ⚠ ${warn}`);
      }
    }
    console.log('');
  }

  if (summary.invalid === 0 && summary.duplicates === 0) {
    console.log('✅ All records are valid!\n');
  } else {
    console.log(`❌ Found ${summary.invalid} invalid records and ${summary.duplicates} duplicate phone(s).\n`);
    console.log('Fix the issues above in your Google Sheet before activating workflows.\n');
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const filePath = args[0];
  const shouldFix = args.includes('--fix');

  if (!filePath) {
    console.error('Usage: node validate-patient-data.js <path-to-patients.json> [--fix]');
    console.error('');
    console.error('  --fix    Output a normalised version of the records (patients-fixed.json)');
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

  let patients;
  try {
    patients = JSON.parse(raw);
  } catch (e) {
    console.error(`Invalid JSON in file: ${filePath}\n${e.message}`);
    process.exit(1);
  }

  const result = validateBatch(patients);
  printReport(result);

  if (shouldFix) {
    const fixedPatients = result.results
      .filter(r => r.valid)
      .map(r => r.normalised);

    const outPath = path.join(
      path.dirname(filePath),
      path.basename(filePath, '.json') + '-fixed.json'
    );
    fs.writeFileSync(outPath, JSON.stringify(fixedPatients, null, 2));
    console.log(`Fixed records written to: ${outPath}`);
    console.log(`(${fixedPatients.length} valid records, ${result.summary.invalid} invalid records excluded)\n`);
  }

  process.exit(result.summary.invalid > 0 ? 1 : 0);
}

// ─── Exports (for use in n8n Code nodes or other modules) ────────────────────

module.exports = { validatePatient, validateBatch, validatePhone, validateDate };
