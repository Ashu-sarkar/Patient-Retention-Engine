import { describe, expect, it } from 'vitest';
import { parseOverview } from './analytics-validators';
import { normalizeApiError } from './errors';
import { resolveDateRange, formatPercent, validateDateRange } from './date-utils';

describe('date-utils', () => {
  it('resolves this_month preset with from at month start', () => {
    const { fromDate, toDate } = resolveDateRange('this_month');
    expect(fromDate.endsWith('-01') || fromDate.match(/^\d{4}-\d{2}-\d{2}$/)).toBeTruthy();
    expect(toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('formats percent values', () => {
    expect(formatPercent(72.4)).toBe('72.4%');
    expect(formatPercent(0)).toBe('0.0%');
  });

  it('rejects invalid custom date ranges', () => {
    expect(validateDateRange('2026-06-10', '2026-06-01')).toMatch(/End date/);
    expect(validateDateRange('bad-date', '2026-06-01')).toMatch(/valid start/);
  });
});

describe('errors', () => {
  it('normalizes unauthorized RPC errors', () => {
    const err = normalizeApiError({ message: 'not authorized', code: '42501' });
    expect(err.message).toMatch(/session expired/i);
    expect(err.code).toBe('unauthorized');
  });
});

describe('analytics-validators', () => {
  it('parses overview payloads defensively', () => {
    const overview = parseOverview({
      patients: { today: '4', week: 10, month: 20 },
      followups: { today: 1, week: 2, month: 3 },
      new_vs_returning: { new: 2, returning: 8, new_pct: 20 },
      retention_rate: 75,
      overdue_followups: 1,
      period: { from: '2026-06-01', to: '2026-06-28' },
    });
    expect(overview.patients.today).toBe(4);
    expect(overview.retention_rate).toBe(75);
  });
});
