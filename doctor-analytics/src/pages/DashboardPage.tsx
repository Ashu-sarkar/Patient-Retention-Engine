import { Suspense, lazy, useRef } from 'react';
import { FilterBar } from '@/components/layout/FilterBar';
import { Header } from '@/components/layout/Header';
import { KpiCard, KpiGrid, OutcomeKpiGrid } from '@/components/kpis/KpiGrid';
import {
  DashboardSkeleton,
  FollowupPipelineTable,
  MonthlySummaryTable,
  RecentVisitsTable,
} from '@/components/tables/DashboardTables';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { QuerySection } from '@/components/ui/QuerySection';
import { useAnalyticsFilters } from '@/hooks/useAnalyticsFilters';
import { useDashboardData } from '@/hooks/useDashboardData';
import { formatPercent } from '@/lib/date-utils';
import type { DoctorProfile } from '@/types/analytics';

const VisitsBarChart = lazy(() =>
  import('@/components/charts/DashboardCharts').then((m) => ({ default: m.VisitsBarChart })),
);
const FollowupLineChart = lazy(() =>
  import('@/components/charts/DashboardCharts').then((m) => ({ default: m.FollowupLineChart })),
);
const NewReturningChart = lazy(() =>
  import('@/components/charts/DashboardCharts').then((m) => ({ default: m.NewReturningChart })),
);

function ChartFallback() {
  return <div className="card p-4"><div className="skeleton h-72 w-full" /></div>;
}

interface DashboardPageProps {
  profile: DoctorProfile;
  onSignOut: () => void;
}

export function DashboardPage({ profile, onSignOut }: DashboardPageProps) {
  const followupRef = useRef<HTMLElement>(null);
  const filters = useAnalyticsFilters(profile);
  const data = useDashboardData(filters.filter);

  function scrollToFollowups() {
    followupRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const overview = data.overview.data;

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-5">
      <Header profile={profile} onSignOut={onSignOut} />

      <div className="grid gap-4">
        <FilterBar
          profile={profile}
          preset={filters.preset}
          setPreset={filters.setPreset}
          customFrom={filters.customFrom}
          setCustomFrom={filters.setCustomFrom}
          customTo={filters.customTo}
          setCustomTo={filters.setCustomTo}
          doctorProfileId={filters.doctorProfileId}
          setDoctorProfileId={filters.setDoctorProfileId}
          patientType={filters.patientType}
          setPatientType={filters.setPatientType}
          includeDemo={filters.includeDemo}
          setIncludeDemo={filters.setIncludeDemo}
          dateRangeError={filters.dateRangeError}
          onRefresh={() => void data.refetchAll()}
          refreshing={data.isFetching}
        />

        {filters.dateRangeError ? (
          <div className="card border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {filters.dateRangeError}
          </div>
        ) : null}

        {data.isInitialLoading ? <DashboardSkeleton /> : null}

        {data.hasHardError && !overview ? (
          <QuerySection
            isLoading={false}
            isFetching={false}
            isError
            error={data.overview.error}
            onRetry={() => void data.refetchAll()}
          >
            {null}
          </QuerySection>
        ) : null}

        {overview ? (
          <>
            <section>
              <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Patient visits</h2>
              <KpiGrid>
                <KpiCard label="Patients today" value={overview.patients.today} />
                <KpiCard label="Patients this week" value={overview.patients.week} />
                <KpiCard label="Patients this month" value={overview.patients.month} />
                <KpiCard label="Follow-ups today" value={overview.followups.today} />
                <KpiCard label="Follow-ups this week" value={overview.followups.week} />
                <KpiCard label="Follow-ups this month" value={overview.followups.month} />
              </KpiGrid>
            </section>

            <section>
              <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Outcomes</h2>
              <OutcomeKpiGrid>
                <KpiCard
                  label="New vs returning (period)"
                  value={`${overview.new_vs_returning.new} / ${overview.new_vs_returning.returning}`}
                  hint={`${formatPercent(overview.new_vs_returning.new_pct)} new`}
                />
                <KpiCard
                  label="Retention rate"
                  value={formatPercent(overview.retention_rate)}
                  hint="Return visits ÷ follow-ups due in selected period"
                  tone="success"
                />
                <KpiCard
                  label="Overdue follow-ups"
                  value={overview.overdue_followups}
                  hint="Click to jump to follow-up table"
                  tone={overview.overdue_followups > 0 ? 'warning' : 'default'}
                  onClick={scrollToFollowups}
                />
              </OutcomeKpiGrid>
            </section>

            <div className="grid gap-4 xl:grid-cols-2">
              <ErrorBoundary title="Visits chart failed to render">
                <QuerySection
                  isLoading={data.visitTrends.isLoading && !data.visitTrends.data}
                  isFetching={data.visitTrends.isFetching}
                  isError={data.visitTrends.isError}
                  error={data.visitTrends.error}
                  isEmpty={!data.visitTrends.data?.length}
                  onRetry={() => void data.visitTrends.refetch()}
                >
                  <Suspense fallback={<ChartFallback />}>
                    <VisitsBarChart data={data.visitTrends.data ?? []} />
                  </Suspense>
                </QuerySection>
              </ErrorBoundary>

              <ErrorBoundary title="Follow-up trends failed to render">
                <QuerySection
                  isLoading={data.followupTrends.isLoading && !data.followupTrends.data}
                  isFetching={data.followupTrends.isFetching}
                  isError={data.followupTrends.isError}
                  error={data.followupTrends.error}
                  isEmpty={!data.followupTrends.data?.length}
                  onRetry={() => void data.followupTrends.refetch()}
                >
                  <Suspense fallback={<ChartFallback />}>
                    <FollowupLineChart data={data.followupTrends.data ?? []} />
                  </Suspense>
                </QuerySection>
              </ErrorBoundary>
            </div>

            <ErrorBoundary title="New vs returning chart failed to render">
              <QuerySection
                isLoading={data.newReturningTrends.isLoading && !data.newReturningTrends.data}
                isFetching={data.newReturningTrends.isFetching}
                isError={data.newReturningTrends.isError}
                error={data.newReturningTrends.error}
                isEmpty={!data.newReturningTrends.data?.length}
                onRetry={() => void data.newReturningTrends.refetch()}
              >
                <Suspense fallback={<ChartFallback />}>
                  <NewReturningChart data={data.newReturningTrends.data ?? []} />
                </Suspense>
              </QuerySection>
            </ErrorBoundary>

            <QuerySection
              isLoading={data.recentVisits.isLoading && !data.recentVisits.data}
              isFetching={data.recentVisits.isFetching}
              isError={data.recentVisits.isError}
              error={data.recentVisits.error}
              isEmpty={!data.recentVisits.data?.rows.length}
              onRetry={() => void data.recentVisits.refetch()}
            >
              <RecentVisitsTable rows={data.recentVisits.data?.rows ?? []} />
            </QuerySection>

            <section ref={followupRef}>
              <QuerySection
                isLoading={data.followupPipeline.isLoading && !data.followupPipeline.data}
                isFetching={data.followupPipeline.isFetching}
                isError={data.followupPipeline.isError}
                error={data.followupPipeline.error}
                isEmpty={!data.followupPipeline.data?.rows.length}
                onRetry={() => void data.followupPipeline.refetch()}
              >
                <FollowupPipelineTable rows={data.followupPipeline.data?.rows ?? []} />
              </QuerySection>
            </section>

            <QuerySection
              isLoading={data.monthlySummary.isLoading && !data.monthlySummary.data}
              isFetching={data.monthlySummary.isFetching}
              isError={data.monthlySummary.isError}
              error={data.monthlySummary.error}
              isEmpty={!data.monthlySummary.data?.length}
              onRetry={() => void data.monthlySummary.refetch()}
            >
              <MonthlySummaryTable rows={data.monthlySummary.data ?? []} />
            </QuerySection>
          </>
        ) : null}
      </div>
    </div>
  );
}
