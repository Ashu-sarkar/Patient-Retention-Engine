#!/usr/bin/env node
'use strict';

const JOURNEY_TEMPLATE_MAP = {
  medicine_journey_day1_morning: 'TWILIO_CONTENT_MEDICINE_JOURNEY_DAY1_MORNING',
  medicine_journey_day1_evening: 'TWILIO_CONTENT_MEDICINE_JOURNEY_DAY1_EVENING',
  medicine_journey_midpoint: 'TWILIO_CONTENT_MEDICINE_JOURNEY_MIDPOINT',
  medicine_journey_daily: 'TWILIO_CONTENT_MEDICINE_JOURNEY_DAILY',
  medicine_journey_last_day: 'TWILIO_CONTENT_MEDICINE_JOURNEY_LAST_DAY',
  medicine_journey_complete: 'TWILIO_CONTENT_MEDICINE_JOURNEY_COMPLETE',
};

const STANDALONE_TEMPLATE_MAP = {
  morning: 'TWILIO_CONTENT_MEDICINE_REMINDER_MORNING',
  afternoon: 'TWILIO_CONTENT_MEDICINE_REMINDER_AFTERNOON',
  evening: 'TWILIO_CONTENT_MEDICINE_REMINDER_NIGHT',
};

const TIMING_SLOT = [
  { match: /empty stomach|before breakfast|after breakfast/i, slot: 'morning' },
  { match: /before lunch|after lunch/i, slot: 'afternoon' },
  { match: /evening|before dinner|after dinner|bedtime/i, slot: 'evening' },
];

function parseCourseDays(duration) {
  const match = String(duration || '').match(/(\d+)/);
  return match ? Math.max(1, parseInt(match[1], 10)) : 1;
}

function maxCourseDays(medicines = []) {
  if (!medicines.length) return 1;
  return Math.max(...medicines.map((m) => parseCourseDays(m.duration)));
}

function timingSlot(timing) {
  const text = String(timing || '');
  for (const rule of TIMING_SLOT) {
    if (rule.match.test(text)) return rule.slot;
  }
  return 'morning';
}

function addDaysISO(isoDate, offset) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function buildJourneyScheduleRows({
  clinicId,
  patientId,
  prescriptionId,
  medicineName,
  courseDays,
  courseStartDate,
}) {
  const rows = [];
  const push = (messageType, scheduledDate, sendSlot) => {
    rows.push({
      clinic_id: clinicId,
      patient_id: patientId,
      prescription_id: prescriptionId,
      medicine_name: medicineName,
      course_days: courseDays,
      course_start_date: courseStartDate,
      scheduled_date: scheduledDate,
      send_slot: sendSlot,
      template_id: messageType,
      message_type: messageType,
      content_env_key: JOURNEY_TEMPLATE_MAP[messageType],
      status: 'pending',
    });
  };

  if (courseDays < 3) return rows;

  push('medicine_journey_day1_morning', addDaysISO(courseStartDate, 1), 'morning');
  push('medicine_journey_day1_evening', addDaysISO(courseStartDate, 1), 'evening');

  const midpointOffset = Math.ceil(courseDays / 2);
  push('medicine_journey_midpoint', addDaysISO(courseStartDate, midpointOffset), 'morning');

  for (let day = 2; day < courseDays; day += 1) {
    push('medicine_journey_daily', addDaysISO(courseStartDate, day), 'morning');
  }

  push('medicine_journey_last_day', addDaysISO(courseStartDate, courseDays), 'morning');
  push('medicine_journey_complete', addDaysISO(courseStartDate, courseDays), 'evening');

  return rows;
}

function buildStandaloneScheduleRows({
  clinicId,
  patientId,
  prescriptionId,
  medicines,
  courseStartDate,
}) {
  const rows = [];
  for (const med of medicines) {
    const days = parseCourseDays(med.duration);
    const slot = timingSlot(med.timing);
    const messageType = `medicine_reminder_${slot === 'evening' ? 'night' : slot}`;
    const contentEnvKey = STANDALONE_TEMPLATE_MAP[slot];
    for (let day = 1; day <= days; day += 1) {
      rows.push({
        clinic_id: clinicId,
        patient_id: patientId,
        prescription_id: prescriptionId,
        medicine_name: med.medicine_name,
        course_days: days,
        course_start_date: courseStartDate,
        scheduled_date: addDaysISO(courseStartDate, day),
        send_slot: slot,
        template_id: messageType,
        message_type: `${messageType}:${med.medicine_name}:${day}`,
        content_env_key: contentEnvKey,
        status: 'pending',
      });
    }
  }
  return rows;
}

function buildMedicineReminderSchedule(input) {
  const courseDays = maxCourseDays(input.medicines);
  const primaryMedicine = [...(input.medicines || [])].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))[0];
  const medicineName = primaryMedicine?.medicine_name || 'your medicine';

  if (courseDays >= 3) {
    return buildJourneyScheduleRows({
      clinicId: input.clinicId,
      patientId: input.patientId,
      prescriptionId: input.prescriptionId,
      medicineName,
      courseDays,
      courseStartDate: input.courseStartDate,
    });
  }

  return buildStandaloneScheduleRows({
    clinicId: input.clinicId,
    patientId: input.patientId,
    prescriptionId: input.prescriptionId,
    medicines: input.medicines || [],
    courseStartDate: input.courseStartDate,
  });
}

module.exports = {
  parseCourseDays,
  maxCourseDays,
  timingSlot,
  buildMedicineReminderSchedule,
  JOURNEY_TEMPLATE_MAP,
  STANDALONE_TEMPLATE_MAP,
};
