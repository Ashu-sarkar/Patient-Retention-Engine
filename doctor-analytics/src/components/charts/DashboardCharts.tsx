import { memo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TrendPoint } from '@/types/analytics';

function ChartCard({ title, children, empty }: { title: string; children: React.ReactNode; empty?: boolean }) {
  return (
    <section className="card p-4">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">{title}</h2>
      {empty ? <p className="py-10 text-center text-sm text-muted">No data for this period.</p> : children}
    </section>
  );
}

export const VisitsBarChart = memo(function VisitsBarChart({ data }: { data: TrendPoint[] }) {
  return (
    <ChartCard title="Monthly patient visits" empty={!data.length}>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#dbe7e4" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
            <Tooltip />
            <Bar dataKey="visits" fill="#117c72" radius={[6, 6, 0, 0]} name="Visits" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
});

export const FollowupLineChart = memo(function FollowupLineChart({ data }: { data: TrendPoint[] }) {
  return (
    <ChartCard title="Follow-up trends" empty={!data.length}>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#dbe7e4" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="scheduled" stroke="#117c72" strokeWidth={2} name="Scheduled" dot={false} />
            <Line type="monotone" dataKey="completed" stroke="#157d46" strokeWidth={2} name="Completed" dot={false} />
            <Line type="monotone" dataKey="overdue" stroke="#bc3151" strokeWidth={2} name="Overdue" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
});

export const NewReturningChart = memo(function NewReturningChart({ data }: { data: TrendPoint[] }) {
  return (
    <ChartCard title="New vs returning patients" empty={!data.length}>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#dbe7e4" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            <Bar dataKey="new" stackId="a" fill="#2f65d5" name="New" radius={[0, 0, 0, 0]} />
            <Bar dataKey="returning" stackId="a" fill="#117c72" name="Returning" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
});
