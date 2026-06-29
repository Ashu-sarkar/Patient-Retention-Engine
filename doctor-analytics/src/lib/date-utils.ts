import { endOfMonth, format, startOfMonth, startOfWeek, subDays } from 'date-fns';
import type { AnalyticsFilter, DatePreset, PatientTypeFilter } from '@/types/analytics';

export function todayISO(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

export function resolveDateRange(preset: DatePreset, customFrom?: string, customTo?: string) {
  const today = new Date();
  switch (preset) {
    case 'today':
      return { fromDate: todayISO(), toDate: todayISO() };
    case 'this_week':
      return {
        fromDate: format(startOfWeek(today, { weekStartsOn: 1 }), 'yyyy-MM-dd'),
        toDate: todayISO(),
      };
    case 'this_month':
      return {
        fromDate: format(startOfMonth(today), 'yyyy-MM-dd'),
        toDate: todayISO(),
      };
    case 'last_30':
      return { fromDate: format(subDays(today, 29), 'yyyy-MM-dd'), toDate: todayISO() };
    case 'last_90':
      return { fromDate: format(subDays(today, 89), 'yyyy-MM-dd'), toDate: todayISO() };
    case 'last_180':
      return { fromDate: format(subDays(today, 179), 'yyyy-MM-dd'), toDate: todayISO() };
    case 'last_365':
      return { fromDate: format(subDays(today, 364), 'yyyy-MM-dd'), toDate: todayISO() };
    case 'custom':
      return {
        fromDate: customFrom || format(startOfMonth(today), 'yyyy-MM-dd'),
        toDate: customTo || todayISO(),
      };
    default:
      return {
        fromDate: format(startOfMonth(today), 'yyyy-MM-dd'),
        toDate: format(endOfMonth(today), 'yyyy-MM-dd'),
      };
  }
}

export function filtersToQueryKey(filter: AnalyticsFilter): string {
  return JSON.stringify(filter);
}

export function formatPercent(value: number): string {
  return `${Number(value || 0).toFixed(1)}%`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value || 0);
}

export function patientTypeLabel(value: PatientTypeFilter): string {
  switch (value) {
    case 'new':
      return 'New only';
    case 'returning':
      return 'Returning only';
    default:
      return 'All patients';
  }
}

export function presetLabel(preset: DatePreset): string {
  switch (preset) {
    case 'today':
      return 'Today';
    case 'this_week':
      return 'This week';
    case 'this_month':
      return 'This month';
    case 'last_30':
      return 'Last 30 days';
    case 'last_90':
      return 'Last 90 days';
    case 'last_180':
      return 'Last 6 months';
    case 'last_365':
      return 'Last 12 months';
    case 'custom':
      return 'Custom range';
    default:
      return preset;
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

export function validateDateRange(fromDate: string, toDate: string): string | null {
  if (!isValidIsoDate(fromDate) || !isValidIsoDate(toDate)) {
    return 'Enter valid start and end dates.';
  }
  if (toDate < fromDate) {
    return 'End date must be on or after the start date.';
  }
  const from = new Date(`${fromDate}T00:00:00`);
  const to = new Date(`${toDate}T00:00:00`);
  const diffDays = Math.floor((to.getTime() - from.getTime()) / 86400000);
  if (diffDays > 730) {
    return 'Date range cannot exceed 24 months.';
  }
  return null;
}
