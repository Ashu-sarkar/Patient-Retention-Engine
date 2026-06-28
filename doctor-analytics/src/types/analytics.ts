export type PatientTypeFilter = 'all' | 'new' | 'returning';

export type DatePreset =
  | 'today'
  | 'this_week'
  | 'this_month'
  | 'last_30'
  | 'last_90'
  | 'custom';

export interface AnalyticsFilter {
  clinicId: string;
  fromDate: string;
  toDate: string;
  doctorProfileId: string | null;
  patientType: PatientTypeFilter;
  includeDemo: boolean;
}

export interface AnalyticsOverview {
  patients: { today: number; week: number; month: number };
  followups: { today: number; week: number; month: number };
  new_vs_returning: { new: number; returning: number; new_pct: number };
  retention_rate: number;
  overdue_followups: number;
  period: { from: string; to: string };
}

export interface TrendPoint {
  period: string;
  label: string;
  visits?: number;
  scheduled?: number;
  completed?: number;
  overdue?: number;
  new?: number;
  returning?: number;
}

export interface RecentVisitRow {
  visit_id: string;
  patient_id: string;
  patient_code: string | null;
  patient_name: string;
  doctor_name: string | null;
  visit_date: string;
  visit_status: string;
  chief_complaint: string | null;
  checked_in_at: string | null;
  is_new: boolean;
}

export interface FollowupPipelineRow {
  patient_id: string;
  patient_code: string | null;
  patient_name: string;
  phone: string;
  follow_up_date: string;
  follow_up_bucket: 'overdue' | 'due_today' | 'upcoming';
  patient_status: string;
  days_overdue: number;
  doctor_profile_id: string | null;
}

export interface MonthlySummaryRow {
  month: string;
  label: string;
  visits: number;
  new_patients: number;
  returning_patients: number;
  followups_due: number;
  followups_completed: number;
  retention_rate: number;
}

export interface ClinicDoctor {
  doctor_profile_id: string;
  doctor_name: string;
  is_clinic_admin: boolean;
  is_self: boolean;
}

export interface DoctorProfile {
  id: string;
  clinic_id: string;
  doctor_name: string;
  clinic_name: string;
  is_clinic_admin: boolean;
}

export interface PaginatedRows<T> {
  total: number;
  rows: T[];
}
