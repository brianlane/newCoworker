/**
 * Pure matcher for a teammate's "1" claim reply against recent routed runs:
 * the precedence engine behind live claims, true late (retroactive) claims,
 * the first-to-claim yank, and the idempotent "already yours" re-ack.
 *
 * The webhook (telnyx-sms-inbound tryLateClaim) pre-fetches the candidate
 * rows and EXECUTES the decision this function returns; all of the business
 * logic — eligibility, bucket precedence, the bare-"1"-only yank rule — lives
 * here where vitest can pin it down. Same pattern as stale_offer.ts.
 */
import { routingOfContext } from "./routing.ts";

/** The run-row shape the webhook fetches for the late-claim scan. */
export type LateClaimCandidate = {
  id: string;
  status: string;
  context: Record<string, unknown> | null;
  awaiting_agent_e164: string | null;
  current_step: number | null;
  updated_at: string;
  /** Optimistic-concurrency counter (bumped by DB trigger on every update). */
  revision: number;
};

export type LateClaimMatch = {
  /**
   * live — the sender's own active offer (any "1" form claims);
   * late — a lapsed offer whose post-route steps already ran (re-open,
   *        claim/notify only, no step replay);
   * yank — first-to-claim: an offer live with ANOTHER teammate that this
   *        sender was texted earlier; bare "1" only;
   * mine — the sender already holds this lead (idempotent re-ack).
   */
  kind: "live" | "late" | "yank" | "mine";
  row: LateClaimCandidate;
  /** Rewind target (routing.step_index); -1 for "mine" (nothing re-opens). */
  stepIndex: number;
};

/**
 * Classify a "1" reply against the candidate runs (newest-first, same set the
 * stale classifier scans) and pick by PRECEDENCE rather than raw recency:
 * live → late → yank → mine. Within each bucket the newest candidate wins.
 * Returns null when nothing is claimable so the caller can fall through
 * (stale-offer ack → normal inbound path).
 *
 * Rules pinned here (see tests):
 * - Only digit "1" ever matches — the universal claim digit.
 * - A run claimed by someone else never matches; claimed by the sender is
 *   the "mine" re-ack.
 * - A fresh claim needs routing.step_index (the worker's rewind stamp).
 * - live: the sender IS routing.offered and post-route steps haven't run.
 * - late: post-route steps already ran (status done, or current_step moved
 *   past the route step) and the sender was ever offered the lead.
 * - yank: the offer is live with another teammate; the sender is in
 *   routing.offered_log (actually TEXTED an offer — `tried` also collects
 *   skips); the reply is BARE (no timeframe — an ETA means "not right now"
 *   and must not preempt the active countdown); and the flow didn't opt out
 *   (routing.first_to_claim === false).
 */
export function matchLateClaimReply(args: {
  candidates: readonly LateClaimCandidate[];
  from: string;
  digit: string;
  /** Comma'd free text of the reply, "" for a bare digit. */
  timeframe: string;
  nowMs: number;
  windowMs: number;
}): LateClaimMatch | null {
  const { candidates, from, digit, timeframe, nowMs, windowMs } = args;

  let live: LateClaimMatch | null = null;
  let late: LateClaimMatch | null = null;
  let yank: LateClaimMatch | null = null;
  let mine: LateClaimMatch | null = null;

  for (const row of candidates) {
    if (live && late && yank && mine) break;
    const routing = routingOfContext(row.context);
    if (!routing) continue;
    if (nowMs - Date.parse(row.updated_at) > windowMs) continue;
    // "1" is the universal claim digit; no other digit ever (late-)claims.
    if (digit !== "1") continue;
    const claimedBy = routing.claimed_by ?? "";
    // Claimed by someone else → not available to this teammate.
    if (claimedBy && claimedBy !== from) continue;
    // Already this teammate's lead (claimed via an earlier "1"): re-ack
    // without re-opening. The worker clears routing.step_index when it
    // finalizes a claim, so this idempotent path must NOT require step_index.
    if (claimedBy === from) {
      if (!mine) mine = { kind: "mine", row, stepIndex: -1 };
      continue;
    }
    // A fresh claim needs the rewind target the worker stamped on park.
    const stepIndex = routing.step_index ?? -1;
    if (stepIndex < 0) continue;
    const offered = routing.offered ?? "";
    const tried = routing.tried ?? [];
    const everOffered =
      offered === from || row.awaiting_agent_e164 === from || tried.includes(from);
    if (!everOffered) continue;
    // Did the steps AFTER route_to_team already run? They did if the run
    // completed (status "done") OR the worker advanced current_step past the
    // route step (owner fallback ran later steps, then parked on e.g. a
    // quiet-hours defer or approval gate). Those are TRUE late claims.
    const currentStep = typeof row.current_step === "number" ? row.current_step : stepIndex;
    const postRouteRan = row.status === "done" || currentStep > stepIndex;
    if (postRouteRan) {
      if (!late) late = { kind: "late", row, stepIndex };
      continue;
    }
    // Still a LIVE offer parked at the route step (later steps not run yet).
    if (offered === from) {
      if (!live) live = { kind: "live", row, stepIndex };
      continue;
    }
    // First-to-claim yank (see doc above): bare "1" only, offered_log only,
    // and never when the flow opted out.
    const offeredLog = routing.offered_log ?? [];
    if (
      !yank &&
      timeframe === "" &&
      offeredLog.includes(from) &&
      routing.first_to_claim !== false
    ) {
      yank = { kind: "yank", row, stepIndex };
    }
  }

  return live ?? late ?? yank ?? mine;
}
