import type { ReactNode } from 'react';
import { formatNumber } from '@/lib/date-utils';

interface KpiCardProps {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'warning' | 'success';
  onClick?: () => void;
}

export function KpiCard({ label, value, hint, tone = 'default', onClick }: KpiCardProps) {
  const toneClass =
    tone === 'warning'
      ? 'border-rose-200 bg-rose-50/70'
      : tone === 'success'
        ? 'border-emerald-200 bg-emerald-50/70'
        : '';

  return (
    <button
      type="button"
      className={`stat-card text-left ${toneClass} ${onClick ? 'cursor-pointer hover:shadow-md' : ''}`}
      onClick={onClick}
      disabled={!onClick}
    >
      <div className="stat-value">{typeof value === 'number' ? formatNumber(value) : value}</div>
      <div className="stat-label">{label}</div>
      {hint ? <div className="mt-1 text-[11px] text-muted">{hint}</div> : null}
    </button>
  );
}

interface KpiGridProps {
  children: ReactNode;
}

export function KpiGrid({ children }: KpiGridProps) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">{children}</div>;
}

export function OutcomeKpiGrid({ children }: KpiGridProps) {
  return <div className="grid gap-3 md:grid-cols-3">{children}</div>;
}
