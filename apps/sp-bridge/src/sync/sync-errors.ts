/**
 * Sync failure classification.
 *
 * A failed cycle must answer "what now?" differently per cause: an expired
 * token needs a human with a new `accessToken` (there is no password login to
 * redeem — the server uses magic links and passkeys, JWTs live 365 days), a
 * dead network needs a wait, a crypto failure needs investigation. Collapsing
 * all three into one message string is how a bridge "silently stops syncing".
 * The code travels in `SyncEngineStatus` so `GET /sync/status` can alert on
 * `auth_failed` without parsing prose.
 */
import {
  AuthFailSPError,
  MissingCredentialsSPError,
  NetworkUnavailableSPError,
} from '@sp/sync-providers/errors';
import { SyncCryptoError } from './crypto';

export type SyncErrorCode =
  | 'auth_failed'
  | 'not_configured'
  | 'encryption'
  | 'network'
  | 'server'
  | 'interrupted'
  | 'unknown';

export const classifySyncError = (error: unknown): SyncErrorCode => {
  if (
    error instanceof AuthFailSPError ||
    error instanceof MissingCredentialsSPError ||
    (error instanceof Error && /HTTP 40[13]\b/.test(error.message))
  ) {
    return 'auth_failed';
  }
  if (
    error instanceof SyncCryptoError ||
    (error instanceof Error && /decrypt|plaintext/i.test(error.message))
  ) {
    return 'encryption';
  }
  if (
    error instanceof NetworkUnavailableSPError ||
    error instanceof TypeError ||
    (error instanceof Error &&
      /fetch failed|network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|abort/i.test(
        error.message,
      ))
  ) {
    return 'network';
  }
  if (error instanceof Error && /HTTP 5\d\d\b/.test(error.message)) {
    return 'server';
  }
  if (error instanceof Error && /epoch/i.test(error.name)) {
    return 'interrupted';
  }
  return 'unknown';
};

/** Backoff between automatic retries after consecutive failures. */
export const SYNC_RETRY_BASE_MS = 60_000;
export const SYNC_RETRY_MAX_MS = 15 * 60_000;

/** Pure math, exported for tests: 1m, 2m, 4m … capped at 15m. */
export const nextRetryDelayMs = (consecutiveFailures: number): number => {
  if (consecutiveFailures <= 0) {
    return 0;
  }
  const delay = SYNC_RETRY_BASE_MS * 2 ** (consecutiveFailures - 1);
  return Math.min(delay, SYNC_RETRY_MAX_MS);
};

/** Warn while the token still works instead of paging on the first 401. */
export const TOKEN_EXPIRY_WARN_MS = 7 * 24 * 3_600_000;
