import type { ApiResponse } from './types/response/error.response.js';

export function success<T>(data: T, message = 'OK', code = 200): ApiResponse<T> {
  return { code, message, data };
}

/**
 * Transitional helper: returns the envelope and repeats the payload fields at the top level.
 *
 * The frozen API tests in local-env/tests/api/archive-search.spec.ts read `body.comments`,
 * `body.pagination` and `body.forums`. Those tests are locked, so the aliases stay until the
 * public read contract is re-frozen. New code should read `.data`.
 */
export function withLegacy<T extends object>(
  data: T,
  message = 'OK',
  code = 200,
): ApiResponse<T> & T {
  return { ...data, code, message, data };
}
