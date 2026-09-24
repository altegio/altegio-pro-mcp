/**
 * Run one optional read and report an access failure as a status.
 *
 * Diagnostic and evidence-gathering tools read several independent sources; a
 * 403 or 404 on one of them is a finding to report, not a reason to fail the
 * whole call. A missing or expired session is different: it still throws, so
 * the caller gets the authentication instruction instead of a report full of
 * "unavailable".
 */
import { AltegioApiError, AuthenticationError } from '../../utils/errors.js';

export type ProbeStatus = 'ok' | 'forbidden' | 'not_found' | 'unavailable';

export type ProbeResult<T> =
  { status: 'ok'; data: T } | { status: Exclude<ProbeStatus, 'ok'> };

export async function probe<T>(
  work: () => Promise<T>
): Promise<ProbeResult<T>> {
  try {
    return { status: 'ok', data: await work() };
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    const code = error instanceof AltegioApiError ? error.statusCode : null;
    if (code === 401) throw error;
    return {
      status:
        code === 403 ? 'forbidden' : code === 404 ? 'not_found' : 'unavailable',
    };
  }
}
