import { buildPatientDashboardUrl } from '@/lib/analytics-api';
import type { FollowupPipelineRow, MonthlySummaryRow, RecentVisitRow } from '@/types/analytics';
import { formatPercent } from '@/lib/date-utils';

function TableShell({ title, children, empty }: { title: string; children: React.ReactNode; empty?: boolean }) {
  return (
    <section className="card p-4">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">{title}</h2>
      {empty ? <p className="py-8 text-center text-sm text-muted">No records for this period.</p> : children}
    </section>
  );
}

function PatientLink({ patientId, label = 'Open' }: { patientId: string; label?: string }) {
  const href = buildPatientDashboardUrl(patientId);
  if (!href) {
    return <span className="text-xs text-muted">Unavailable</span>;
  }
  return (
    <a className="text-sm font-semibold text-teal hover:underline" href={href} rel="noopener noreferrer">
      {label}
    </a>
  );
}

function bucketClass(bucket: FollowupPipelineRow['follow_up_bucket']) {
  if (bucket === 'overdue') return 'pill-overdue';
  if (bucket === 'due_today') return 'pill-today';
  return 'pill-upcoming';
}

export function RecentVisitsTable({ rows }: { rows: RecentVisitRow[] }) {
  return (
    <TableShell title="Recent patient visits" empty={!rows.length}>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Doctor</th>
              <th>Date</th>
              <th>Status</th>
              <th>Type</th>
              <th>Complaint</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.visit_id}>
                <td>
                  <div className="font-semibold">{row.patient_name}</div>
                  <div className="text-xs text-muted">{row.patient_code || '—'}</div>
                </td>
                <td>{row.doctor_name || '—'}</td>
                <td>{row.visit_date}</td>
                <td>{row.visit_status.replaceAll('_', ' ')}</td>
                <td>{row.is_new ? 'New' : 'Returning'}</td>
                <td className="max-w-[220px] truncate">{row.chief_complaint || '—'}</td>
                <td>
                  <PatientLink patientId={row.patient_id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TableShell>
  );
}

export function FollowupPipelineTable({ rows }: { rows: FollowupPipelineRow[] }) {
  return (
    <TableShell title="Upcoming & overdue follow-ups" empty={!rows.length}>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Follow-up date</th>
              <th>Status</th>
              <th>Days overdue</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.patient_id}-${row.follow_up_date}`} className={row.follow_up_bucket === 'overdue' ? 'bg-rose-50/40' : ''}>
                <td>
                  <div className="font-semibold">{row.patient_name}</div>
                  <div className="text-xs text-muted">{row.patient_code || row.phone}</div>
                </td>
                <td>{row.follow_up_date}</td>
                <td>
                  <span className={bucketClass(row.follow_up_bucket)}>
                    {row.follow_up_bucket.replaceAll('_', ' ')}
                  </span>
                </td>
                <td>{row.days_overdue > 0 ? row.days_overdue : '—'}</td>
                <td>
                  <PatientLink patientId={row.patient_id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TableShell>
  );
}

export function MonthlySummaryTable({ rows }: { rows: MonthlySummaryRow[] }) {
  return (
    <TableShell title="Monthly analytics summary" empty={!rows.length}>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Month</th>
              <th>Visits</th>
              <th>New</th>
              <th>Returning</th>
              <th>Follow-ups due</th>
              <th>Completed</th>
              <th>Retention</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.month}>
                <td className="font-semibold">{row.label}</td>
                <td>{row.visits}</td>
                <td>{row.new_patients}</td>
                <td>{row.returning_patients}</td>
                <td>{row.followups_due}</td>
                <td>{row.followups_completed}</td>
                <td>{formatPercent(row.retention_rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TableShell>
  );
}

function LoadingBlock() {
  return <div className="skeleton h-40 w-full" />;
}

export function DashboardSkeleton() {
  return (
    <div className="grid gap-4">
      <LoadingBlock />
      <div className="grid gap-3 md:grid-cols-3">
        <LoadingBlock />
        <LoadingBlock />
        <LoadingBlock />
      </div>
    </div>
  );
}
