import { keepPreviousData, useQueries } from '@tanstack/react-query';
import {
  fetchAnalyticsOverview,
  fetchFollowupPipeline,
  fetchFollowupTrends,
  fetchMonthlySummary,
  fetchNewVsReturningTrends,
  fetchRecentVisits,
  fetchVisitTrends,
} from '@/lib/analytics-api';
import { filtersToQueryKey } from '@/lib/date-utils';
import type { AnalyticsFilter } from '@/types/analytics';

function queryResult<T>(result: {
  data: T | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
}) {
  return {
    data: result.data,
    isLoading: result.isLoading,
    isFetching: result.isFetching,
    isError: result.isError,
    error: result.error,
    refetch: result.refetch,
  };
}

export function useDashboardData(filter: AnalyticsFilter | null) {
  const enabled = Boolean(filter?.clinicId);
  const key = filter ? filtersToQueryKey(filter) : 'disabled';

  const results = useQueries({
    queries: [
      {
        queryKey: ['overview', key],
        queryFn: () => fetchAnalyticsOverview(filter!),
        enabled,
        placeholderData: keepPreviousData,
      },
      {
        queryKey: ['visitTrends', key],
        queryFn: () => fetchVisitTrends(filter!, 'month'),
        enabled,
        placeholderData: keepPreviousData,
      },
      {
        queryKey: ['followupTrends', key],
        queryFn: () => fetchFollowupTrends(filter!, 'month'),
        enabled,
        placeholderData: keepPreviousData,
      },
      {
        queryKey: ['newReturningTrends', key],
        queryFn: () => fetchNewVsReturningTrends(filter!, 'month'),
        enabled,
        placeholderData: keepPreviousData,
      },
      {
        queryKey: ['recentVisits', key],
        queryFn: () => fetchRecentVisits(filter!, 25, 0),
        enabled,
        placeholderData: keepPreviousData,
      },
      {
        queryKey: ['followupPipeline', key],
        queryFn: () => fetchFollowupPipeline(filter!, 25, 0),
        enabled,
        placeholderData: keepPreviousData,
      },
      {
        queryKey: ['monthlySummary', key],
        queryFn: () => fetchMonthlySummary(filter!),
        enabled,
        placeholderData: keepPreviousData,
      },
    ],
  });

  const isInitialLoading = enabled && results.every((r) => r.isLoading && !r.data);
  const isFetching = results.some((r) => r.isFetching);
  const hasHardError = results.some((r) => r.isError && !r.data);

  return {
    overview: queryResult(results[0]),
    visitTrends: queryResult(results[1]),
    followupTrends: queryResult(results[2]),
    newReturningTrends: queryResult(results[3]),
    recentVisits: queryResult(results[4]),
    followupPipeline: queryResult(results[5]),
    monthlySummary: queryResult(results[6]),
    isInitialLoading,
    isFetching,
    hasHardError,
    refetchAll: () => Promise.all(results.map((r) => r.refetch())),
  };
}
