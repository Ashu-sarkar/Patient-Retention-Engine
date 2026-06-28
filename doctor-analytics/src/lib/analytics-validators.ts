import type {
  AnalyticsOverview,
  ClinicDoctor,
  FollowupPipelineRow,
  MonthlySummaryRow,
  PaginatedRows,
  RecentVisitRow,
  TrendPoint,
} from '@/types/analytics';
import { AnalyticsApiError } from './errors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function parseTrendPoints(raw: unknown): TrendPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((row) => ({
      period: asString(row.period),
      label: asString(row.label),
      visits: row.visits === undefined ? undefined : asNumber(row.visits),
      scheduled: row.scheduled === undefined ? undefined : asNumber(row.scheduled),
      completed: row.completed === undefined ? undefined : asNumber(row.completed),
      overdue: row.overdue === undefined ? undefined : asNumber(row.overdue),
      new: row.new === undefined ? undefined : asNumber(row.new),
      returning: row.returning === undefined ? undefined : asNumber(row.returning),
    }));
}

export function parseOverview(raw: unknown): AnalyticsOverview {
  if (!isRecord(raw)) {
    throw new AnalyticsApiError('Analytics overview response was malformed.', { code: 'invalid_response' });
  }
  const patients = isRecord(raw.patients) ? raw.patients : {};
  const followups = isRecord(raw.followups) ? raw.followups : {};
  const mix = isRecord(raw.new_vs_returning) ? raw.new_vs_returning : {};
  const period = isRecord(raw.period) ? raw.period : {};

  return {
    patients: {
      today: asNumber(patients.today),
      week: asNumber(patients.week),
      month: asNumber(patients.month),
    },
    followups: {
      today: asNumber(followups.today),
      week: asNumber(followups.week),
      month: asNumber(followups.month),
    },
    new_vs_returning: {
      new: asNumber(mix.new),
      returning: asNumber(mix.returning),
      new_pct: asNumber(mix.new_pct),
    },
    retention_rate: asNumber(raw.retention_rate),
    overdue_followups: asNumber(raw.overdue_followups),
    period: {
      from: asString(period.from),
      to: asString(period.to),
    },
  };
}

export function parsePaginatedVisits(raw: unknown): PaginatedRows<RecentVisitRow> {
  if (!isRecord(raw)) {
    return { total: 0, rows: [] };
  }
  const rows = Array.isArray(raw.rows)
    ? raw.rows.filter(isRecord).map((row) => ({
        visit_id: asString(row.visit_id),
        patient_id: asString(row.patient_id),
        patient_code: row.patient_code == null ? null : asString(row.patient_code),
        patient_name: asString(row.patient_name),
        doctor_name: row.doctor_name == null ? null : asString(row.doctor_name),
        visit_date: asString(row.visit_date),
        visit_status: asString(row.visit_status),
        chief_complaint: row.chief_complaint == null ? null : asString(row.chief_complaint),
        checked_in_at: row.checked_in_at == null ? null : asString(row.checked_in_at),
        is_new: Boolean(row.is_new),
      }))
    : [];
  return { total: asNumber(raw.total), rows };
}

export function parsePaginatedFollowups(raw: unknown): PaginatedRows<FollowupPipelineRow> {
  if (!isRecord(raw)) {
    return { total: 0, rows: [] };
  }
  const rows = Array.isArray(raw.rows)
    ? raw.rows.filter(isRecord).map((row) => ({
        patient_id: asString(row.patient_id),
        patient_code: row.patient_code == null ? null : asString(row.patient_code),
        patient_name: asString(row.patient_name),
        phone: asString(row.phone),
        follow_up_date: asString(row.follow_up_date),
        follow_up_bucket: asString(row.follow_up_bucket) as FollowupPipelineRow['follow_up_bucket'],
        patient_status: asString(row.patient_status),
        days_overdue: asNumber(row.days_overdue),
        doctor_profile_id: row.doctor_profile_id == null ? null : asString(row.doctor_profile_id),
      }))
    : [];
  return { total: asNumber(raw.total), rows };
}

export function parseMonthlySummary(raw: unknown): MonthlySummaryRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((row) => ({
    month: asString(row.month),
    label: asString(row.label),
    visits: asNumber(row.visits),
    new_patients: asNumber(row.new_patients),
    returning_patients: asNumber(row.returning_patients),
    followups_due: asNumber(row.followups_due),
    followups_completed: asNumber(row.followups_completed),
    retention_rate: asNumber(row.retention_rate),
  }));
}

export function parseClinicDoctors(raw: unknown): ClinicDoctor[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((row) => ({
      doctor_profile_id: asString(row.doctor_profile_id),
      doctor_name: asString(row.doctor_name),
      is_clinic_admin: Boolean(row.is_clinic_admin),
      is_self: Boolean(row.is_self),
    }))
    .filter((row) => row.doctor_profile_id);
}

export function parseDoctorProfile(raw: unknown) {
  if (!isRecord(raw) || !raw.id || !raw.clinic_id) {
    throw new AnalyticsApiError('Doctor profile response was malformed.', { code: 'invalid_profile' });
  }
  return {
    id: asString(raw.id),
    clinic_id: asString(raw.clinic_id),
    doctor_name: asString(raw.doctor_name),
    clinic_name: asString(raw.clinic_name),
    is_clinic_admin: Boolean(raw.is_clinic_admin),
  };
}
