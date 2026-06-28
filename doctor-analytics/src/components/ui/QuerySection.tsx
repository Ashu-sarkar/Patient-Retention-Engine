import type { ReactNode } from 'react';
import { normalizeApiError } from '@/lib/errors';

interface QuerySectionProps {
  title?: string;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyMessage?: string;
  onRetry?: () => void;
  children: ReactNode;
  skeleton?: ReactNode;
}

export function QuerySection({
  title,
  isLoading,
  isFetching,
  isError,
  error,
  isEmpty,
  emptyMessage = 'No data for this period.',
  onRetry,
  children,
  skeleton,
}: QuerySectionProps) {
  if (isLoading && !isFetching) {
    return (
      <section className="card p-4">
        {title ? <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">{title}</h2> : null}
        {skeleton || <div className="skeleton h-40 w-full" />}
      </section>
    );
  }

  if (isError) {
    const normalized = normalizeApiError(error);
    return (
      <section className="card border-rose-200 bg-rose-50 p-4">
        {title ? <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-rose-800">{title}</h2> : null}
        <p className="text-sm text-rose-700">{normalized.message}</p>
        {onRetry ? (
          <button type="button" className="btn mt-3" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </section>
    );
  }

  if (isEmpty) {
    return (
      <section className="card p-4">
        {title ? <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">{title}</h2> : null}
        <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
      </section>
    );
  }

  return (
    <div className={isFetching ? 'opacity-80 transition-opacity' : undefined}>
      {children}
    </div>
  );
}
