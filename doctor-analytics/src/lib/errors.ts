import type { AuthError, PostgrestError } from '@supabase/supabase-js';

export class AnalyticsApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: { code?: string; retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'AnalyticsApiError';
    this.code = options.code || 'unknown';
    this.retryable = options.retryable ?? false;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function isPostgrestError(error: unknown): error is PostgrestError {
  return Boolean(error && typeof error === 'object' && 'code' in error && 'message' in error);
}

function isAuthError(error: unknown): error is AuthError {
  return Boolean(error && typeof error === 'object' && 'status' in error && 'name' in error);
}

export function normalizeApiError(error: unknown): AnalyticsApiError {
  if (error instanceof AnalyticsApiError) return error;

  if (isPostgrestError(error)) {
    const message = String(error.message || 'Database request failed');
    const unauthorized = /not authorized|jwt|permission|42501/i.test(message);
    const invalidRange = /invalid date range|date range too wide/i.test(message);
    const timeout = /timeout|timed out/i.test(message);

    if (unauthorized) {
      return new AnalyticsApiError('Your session expired or you do not have access to this clinic.', {
        code: 'unauthorized',
        retryable: false,
        cause: error,
      });
    }
    if (invalidRange) {
      return new AnalyticsApiError(message, { code: 'invalid_range', retryable: false, cause: error });
    }
    if (timeout) {
      return new AnalyticsApiError('The analytics request timed out. Try a shorter date range.', {
        code: 'timeout',
        retryable: true,
        cause: error,
      });
    }
    return new AnalyticsApiError(message, { code: error.code || 'rpc_error', retryable: true, cause: error });
  }

  if (isAuthError(error)) {
    const unauthorized = error.status === 401 || error.status === 403;
    return new AnalyticsApiError(
      unauthorized ? 'Invalid username or password.' : error.message || 'Authentication failed.',
      { code: unauthorized ? 'auth_failed' : 'auth_error', retryable: !unauthorized, cause: error },
    );
  }

  if (error instanceof Error) {
    const timeout = /timeout|timed out|aborted/i.test(error.message);
    return new AnalyticsApiError(error.message, {
      code: timeout ? 'timeout' : 'unknown',
      retryable: timeout,
      cause: error,
    });
  }

  return new AnalyticsApiError('Something went wrong while loading analytics.', { code: 'unknown', retryable: true });
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof AnalyticsApiError && error.code === 'unauthorized';
}
