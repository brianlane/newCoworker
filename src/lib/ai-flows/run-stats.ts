/**
 * Pure helpers for presenting AiFlow run statistics (admin card + owner runs
 * page). Kept out of the components so both server and client bundles can
 * share them and they sit under the lib coverage gate.
 */

/**
 * One-line routing summary from a run's context.routing: how many employees
 * were offered the lead and who (if anyone) claimed it. `tried` holds retired
 * offers; the employee currently offered / the claimer is one more on top.
 */
export function routingSummary(context: Record<string, unknown>): string | null {
  const routing = context.routing as Record<string, unknown> | undefined;
  if (!routing || typeof routing !== "object") return null;
  const tried = Array.isArray(routing.tried) ? routing.tried.length : 0;
  const hasCurrentOffer = typeof routing.offered === "string" && routing.offered !== "";
  const claimedName = typeof routing.claimed_name === "string" ? routing.claimed_name : "";
  const claimedBy = typeof routing.claimed_by === "string" ? routing.claimed_by : "";
  const claimed = claimedName || claimedBy;
  const offers = tried + (hasCurrentOffer || claimed ? 1 : 0);
  if (offers === 0) return null;
  const offersPart = `offered to ${offers} employee${offers === 1 ? "" : "s"}`;
  if (claimed) return `${offersPart} · claimed by ${claimed}`;
  if (hasCurrentOffer) return `${offersPart} · awaiting reply`;
  return `${offersPart} · no claim (owner fallback)`;
}

/** "3 retries" / "1 retry" / null — error retries only, never benign re-claims. */
export function retrySummary(errorRetryCount: number): string | null {
  if (!Number.isFinite(errorRetryCount) || errorRetryCount <= 0) return null;
  return `${errorRetryCount} ${errorRetryCount === 1 ? "retry" : "retries"}`;
}
