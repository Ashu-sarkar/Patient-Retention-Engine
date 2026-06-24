#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildMedicineReminderSchedule, parseCourseDays, maxCourseDays } = require('../scripts/lib/medicine-schedule-builder');

assert.strictEqual(parseCourseDays('5 days'), 5);
assert.strictEqual(parseCourseDays('30 days'), 30);
assert.strictEqual(maxCourseDays([{ duration: '3 days' }, { duration: '7 days' }]), 7);

const journey = buildMedicineReminderSchedule({
  clinicId: '00000000-0000-0000-0000-000000000001',
  patientId: '00000000-0000-0000-0000-000000000002',
  prescriptionId: '00000000-0000-0000-0000-000000000003',
  courseStartDate: '2026-06-24',
  medicines: [{ medicine_name: 'Metformin', duration: '7 days', timing: 'After Breakfast', sort_order: 1 }],
});

assert(journey.length >= 6, '7-day course should schedule journey milestones');
assert(journey.some((row) => row.message_type === 'medicine_journey_day1_morning'));
assert(journey.some((row) => row.message_type === 'medicine_journey_complete'));

const standalone = buildMedicineReminderSchedule({
  clinicId: '00000000-0000-0000-0000-000000000001',
  patientId: '00000000-0000-0000-0000-000000000002',
  prescriptionId: '00000000-0000-0000-0000-000000000004',
  courseStartDate: '2026-06-24',
  medicines: [{ medicine_name: 'Paracetamol', duration: '2 days', timing: 'After Dinner', sort_order: 1 }],
});

assert(standalone.every((row) => row.template_id.startsWith('medicine_reminder_')));
assert.strictEqual(standalone.length, 2);

console.log('[medicine-schedule-builder] Passed.');
