/**
 * Loading the admin's TOTP factor list, with the two failure modes that made
 * /admin/mfa unusable on 2026-08-30 designed out.
 *
 * 1. `listFactors()` is one `GET /auth/v1/user` to Supabase. A single dropped
 *    request on a phone left the page with no factor and no way forward, so
 *    the call is retried before it is believed.
 * 2. A transport failure can arrive with an empty `message`, and an empty
 *    string renders as no error at all, which reads as "loaded fine" when
 *    nothing loaded. Every failure is turned into a sentence.
 */

export type MfaFactorSummary = {
  id: string;
  friendly_name?: string;
  factor_type: string;
  status: string;
};

export type MfaFactorList = { all?: MfaFactorSummary[] | null } | null;

export type ListFactorsOutcome = {
  data: MfaFactorList;
  error: unknown;
};

export type ListFactorsFn = () => Promise<ListFactorsOutcome>;

const FACTOR_LOAD_ATTEMPTS = 3;
const FACTOR_LOAD_RETRY_MS = 400;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Always a sentence an admin can act on, never an empty string. */
export function describeMfaLoadFailure(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const detail = raw.trim();
  const base = "Could not load your authenticator from the auth service.";
  return detail
    ? `${base} ${detail}. Check your connection and try again.`
    : `${base} Check your connection and try again.`;
}

/**
 * Retries only the failures. A successful call that legitimately finds no
 * factor is an answer, not an error, and is returned on the first attempt.
 */
export async function listMfaFactorsWithRetry(
  listFactors: ListFactorsFn,
  sleep: (ms: number) => Promise<void> = sleepMs
): Promise<ListFactorsOutcome> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= FACTOR_LOAD_ATTEMPTS; attempt += 1) {
    try {
      const result = await listFactors();
      if (!result.error) return { data: result.data, error: null };
      lastError = result.error;
    } catch (err) {
      lastError = err;
    }
    if (attempt < FACTOR_LOAD_ATTEMPTS) {
      await sleep(FACTOR_LOAD_RETRY_MS * attempt);
    }
  }
  return { data: null, error: lastError };
}

/**
 * Read `all`, never `totp`. auth-js files ONLY verified factors under
 * `data.totp` (see its `_listFactors`: the `data[factor.factor_type].push`
 * sits inside an `if (factor.status === 'verified')`). Filtering `data.totp`
 * for unverified rows can therefore never match, which is how the cleanup of
 * half-finished enrollments quietly stopped running.
 */
export function splitTotpFactors(list: MfaFactorList): {
  totp: MfaFactorSummary[];
  verified: MfaFactorSummary[];
  unverified: MfaFactorSummary[];
} {
  const totp = (list?.all ?? []).filter((f) => f.factor_type === "totp");
  return {
    totp,
    verified: totp.filter((f) => f.status === "verified"),
    unverified: totp.filter((f) => f.status !== "verified")
  };
}
