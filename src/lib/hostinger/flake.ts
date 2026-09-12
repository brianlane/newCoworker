/**
 * Hostinger timeout / network flakes: real, recorded, not worth paging
 * until they repeat.
 *
 * The client aborts at 30s (`HostingerClient` default). The catalog routinely
 * takes 10 to 15s, so a slow day lands as `timed out after 30000ms`. A
 * one-off of that is not an outage a human here can fix; two in a 48h window
 * (two daily cron ticks) is.
 *
 * Same judgement as `recordFailure` on the fleet System Errors card, and
 * the same matcher the billing-posture cron uses for a VM lookup timeout.
 */

/** Daily-cron analog of `FAILURE_ESCALATION_WINDOW_MINUTES` (15) on a ~1/min poll. */
export const HOSTINGER_FLAKE_WINDOW_MINUTES = 48 * 60;

/**
 * True when the text is a Hostinger timeout or network drop, not a hard
 * miss like HTTP 404.
 *
 * Matches the HostingerClient error text:
 * `Hostinger API ${path} timed out after ${timeoutMs}ms` and
 * `Hostinger API ${path} network error: ...`.
 */
export function isHostingerFlakeMessage(text: string): boolean {
  return /timed out after \d+ms/.test(text) || /network error/.test(text);
}

export function hostingerFlakeDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isHostingerFlakeError(err: unknown): boolean {
  const detail = hostingerFlakeDetail(err);
  if (!isHostingerFlakeMessage(detail)) return false;
  return /Hostinger API /.test(detail) || (err instanceof Error && err.name === "HostingerApiError");
}

/**
 * Run `fn` once more if the first attempt is a Hostinger timeout or network
 * drop. Any other error is thrown immediately. A second flake is thrown so
 * the caller can record it rather than treating a retry that also failed as
 * success.
 */
export async function retryOnceOnHostingerFlake<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isHostingerFlakeError(err)) throw err;
    return await fn();
  }
}
