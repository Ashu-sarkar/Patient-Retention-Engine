import { readRuntimeConfig } from './config';
import {
  parseClinicDoctors,
  parseDoctorProfile,
  parseMonthlySummary,
  parseOverview,
  parsePaginatedFollowups,
  parsePaginatedVisits,
  parseTrendPoints,
} from './analytics-validators';
import { AnalyticsApiError, normalizeApiError } from './errors';
import { getSupabase } from './supabase';
import type { AnalyticsFilter } from '@/types/analytics';

const RPC_TIMEOUT_MS = 25_000;

function rpcParams(filter: AnalyticsFilter) {
  return {
    p_clinic_id: filter.clinicId,
    p_from_date: filter.fromDate,
    p_to_date: filter.toDate,
    p_doctor_profile_id: filter.doctorProfileId,
    p_patient_type: filter.patientType,
    p_include_demo: filter.includeDemo,
  };
}

async function withTimeout<T>(promise: PromiseLike<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new AnalyticsApiError(`${label} timed out. Try a shorter date range.`, { code: 'timeout', retryable: true }));
        }, RPC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown>, parse: (raw: unknown) => T): Promise<T> {
  const sb = getSupabase();
  if (!sb) {
    throw new AnalyticsApiError('Supabase is not configured for this deployment.', { code: 'config', retryable: false });
  }

  try {
    const result = await withTimeout(sb.rpc(fn, args), fn);
    if (result.error) throw result.error;
    return parse(result.data);
  } catch (error) {
    throw normalizeApiError(error);
  }
}

export async function fetchDoctorProfile() {
  const sb = getSupabase();
  if (!sb) {
    throw new AnalyticsApiError('Supabase is not configured for this deployment.', { code: 'config', retryable: false });
  }
  try {
    const result = await withTimeout(sb.rpc('get_or_create_doctor_profile_for_current_user'), 'profile');
    if (result.error) throw result.error;
    return parseDoctorProfile(result.data);
  } catch (error) {
    throw normalizeApiError(error);
  }
}

export async function fetchClinicDoctors(clinicId: string) {
  return rpc('doctor_list_clinic_doctors', { p_clinic_id: clinicId }, parseClinicDoctors);
}

export async function fetchAnalyticsOverview(filter: AnalyticsFilter) {
  return rpc('doctor_get_analytics_overview', rpcParams(filter), parseOverview);
}

export async function fetchVisitTrends(filter: AnalyticsFilter, granularity: 'week' | 'month' = 'month') {
  return rpc(
    'doctor_get_visit_trends',
    { ...rpcParams(filter), p_granularity: granularity },
    parseTrendPoints,
  );
}

export async function fetchFollowupTrends(filter: AnalyticsFilter, granularity: 'week' | 'month' = 'month') {
  return rpc(
    'doctor_get_followup_trends',
    {
      p_clinic_id: filter.clinicId,
      p_from_date: filter.fromDate,
      p_to_date: filter.toDate,
      p_doctor_profile_id: filter.doctorProfileId,
      p_include_demo: filter.includeDemo,
      p_granularity: granularity,
    },
    parseTrendPoints,
  );
}

export async function fetchNewVsReturningTrends(filter: AnalyticsFilter, granularity: 'week' | 'month' = 'month') {
  return rpc(
    'doctor_get_new_vs_returning_trends',
    {
      p_clinic_id: filter.clinicId,
      p_from_date: filter.fromDate,
      p_to_date: filter.toDate,
      p_doctor_profile_id: filter.doctorProfileId,
      p_include_demo: filter.includeDemo,
      p_granularity: granularity,
    },
    parseTrendPoints,
  );
}

export async function fetchRecentVisits(filter: AnalyticsFilter, limit = 25, offset = 0) {
  return rpc(
    'doctor_get_recent_visits',
    { ...rpcParams(filter), p_limit: limit, p_offset: offset },
    parsePaginatedVisits,
  );
}

export async function fetchFollowupPipeline(filter: AnalyticsFilter, limit = 25, offset = 0) {
  return rpc(
    'doctor_get_followup_pipeline',
    {
      p_clinic_id: filter.clinicId,
      p_from_date: filter.fromDate,
      p_to_date: filter.toDate,
      p_doctor_profile_id: filter.doctorProfileId,
      p_include_demo: filter.includeDemo,
      p_limit: limit,
      p_offset: offset,
    },
    parsePaginatedFollowups,
  );
}

export async function fetchMonthlySummary(filter: AnalyticsFilter) {
  return rpc('doctor_get_monthly_summary', {
    p_clinic_id: filter.clinicId,
    p_from_date: filter.fromDate,
    p_to_date: filter.toDate,
    p_doctor_profile_id: filter.doctorProfileId,
    p_include_demo: filter.includeDemo,
  }, parseMonthlySummary);
}

export function buildPatientDashboardUrl(patientId: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(patientId)) return null;
  try {
    const { doctorDashboardUrl } = readRuntimeConfig();
    const url = new URL(doctorDashboardUrl);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
      return null;
    }
    url.searchParams.set('patient_id', patientId);
    return url.toString();
  } catch {
    return null;
  }
}
