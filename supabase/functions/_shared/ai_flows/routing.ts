/**
 * THE routing contract: the shape of `context.routing` on a route_to_team run.
 *
 * The inbound webhook (telnyx-sms-inbound) and the engine (ai-flow-worker)
 * communicate exclusively through this object — one stamps, the other reads —
 * so an undocumented convention here becomes a cross-function bug (stale
 * pass_reason, tried-vs-offered_log semantics, …). Every field below documents
 * its full lifecycle: WHO sets it, WHO clears it, and WHAT survives a claim.
 *
 * Lives in `_shared` so the webhook, the worker, and the pure classifiers
 * (stale_offer.ts, late_claim.ts) all compile against one definition, and so
 * vitest can exercise the parsing without booting the Deno HTTP server.
 */

/** The reply/timeout event the webhook or sweep stamped for the worker. */
export type OfferLastEvent = "claim" | "reject" | "timeout" | "unclaim";

export type OfferRouting = {
  /**
   * E.164 of the teammate the offer is CURRENTLY with.
   * Set: worker when it texts an offer; webhook swaps it to the claimer on a
   * late claim / yank. Cleared: worker when retiring an agent (reject/timeout)
   * and when finalizing a claim.
   */
  offered?: string;
  /** Roster name for `offered`. Same lifecycle as `offered`. */
  offered_name?: string;
  /**
   * E.164s that were actually TEXTED an offer for this lead, in order.
   * Set: worker appends on every offer send (and backfills the retiring agent
   * for runs that predate the field). Never cleared — survives the claim.
   * This is the eligibility list for the first-to-claim yank; `tried` is NOT
   * (it also collects opt-out/lead-phone skips that never saw an offer).
   */
  offered_log?: string[];
  /**
   * E.164s already consumed by the escalation loop (offered agents AND
   * skipped ones). Set: worker on retire/skip; webhook adds the preempted
   * teammate on a yank. Never cleared — survives the claim.
   */
  tried?: string[];
  /**
   * E.164 of the teammate who holds the lead. Set: worker when finalizing a
   * claim. Cleared: worker on an unclaim ("86"). Gates every claim path:
   * a lead claimed by someone else is never re-claimable.
   */
  claimed_by?: string;
  /** Roster name for `claimed_by`. Same lifecycle. */
  claimed_name?: string;
  /**
   * Rewind target: the route_to_team step index, stamped by the worker when
   * it parks the run (offer out / owner fallback). Cleared: worker when
   * finalizing a claim. A fresh late claim/yank REQUIRES it (it's where the
   * run re-enters); the idempotent "already yours" re-ack must NOT.
   */
  step_index?: number;
  /**
   * Durable copy of the route step index that SURVIVES the claim, so a
   * later unclaim ("86") can still find where to re-open the run.
   * Set: worker alongside step_index. Never cleared.
   */
  route_step_index?: number;
  /**
   * What just happened, for the worker to consume on resume.
   * Set: webhook (claim/reject/unclaim) or escalation sweep (timeout).
   * Cleared: worker after consuming it.
   */
  last_event?: OfferLastEvent;
  /** E.164 that sent the reply behind last_event. Same lifecycle. */
  reply_from?: string;
  /**
   * ETA the claimer stated ("1, 20 min" → "20 min"). Set: webhook on a
   * comma'd claim; cleared by webhook on an ETA-less claim and by the worker
   * once appended to the owner's claim notice. Never inherited across claims.
   */
  claim_timeframe?: string;
  /**
   * Reason the passer stated ("2, out of town" → "out of town"). Set: webhook
   * on a comma'd pass. Cleared: worker after folding it into pass_reasons
   * (and defensively by every other reply stamper, so a stale reason can
   * never be attributed to a later reply).
   */
  pass_reason?: string;
  /**
   * Accumulated "<name>: <reason>" entries, one per reasoned pass. Set:
   * worker. Never cleared — appended to the owner-fallback SMS and kept as
   * run history.
   */
  pass_reasons?: string[];
  /**
   * First-to-claim opt-out. ONLY ever `false` (on is the default and is
   * represented by ABSENCE). Set/cleared: worker on every offer from the
   * step's firstToClaim option.
   */
  first_to_claim?: boolean;
  /**
   * Marks a claim of a run whose post-route steps ALREADY ran (true late
   * claim): the worker then re-runs only the claim/notify and finalizes
   * without replaying later steps. Set: webhook. Cleared: worker (which
   * stamps late_claimed instead).
   */
  late_claim?: boolean;
  /** Permanent "this run was late-claimed" marker. Set: worker. Never cleared. */
  late_claimed?: boolean;
  /**
   * LEGACY (pre-universal-digits). No longer set anywhere; the worker scrubs
   * them from stored runs on retire/claim so old stamps can't linger.
   * @deprecated
   */
  tf_digit?: string;
  /** LEGACY — see tf_digit. @deprecated */
  late_digit?: string;
};

const STRING_ARRAY_FIELDS = ["offered_log", "tried", "pass_reasons"] as const;
const STRING_FIELDS = [
  "offered",
  "offered_name",
  "claimed_by",
  "claimed_name",
  "reply_from",
  "claim_timeframe",
  "pass_reason"
] as const;
const NUMBER_FIELDS = ["step_index", "route_step_index"] as const;
const LAST_EVENTS: readonly string[] = ["claim", "reject", "timeout", "unclaim"];

/**
 * Normalize a raw `context.routing` value into a typed SHALLOW COPY.
 *
 * - Unknown/legacy keys are preserved at runtime (spread first) so a
 *   parse → mutate → persist round-trip never drops data a newer or older
 *   deploy stamped — but they are invisible to the type, so WRITES to
 *   misspelled fields are compile errors.
 * - Malformed values (wrong JSON type) are dropped rather than trusted, so
 *   readers never need inline `typeof` guards again.
 *
 * Mutating the returned object never mutates the source; callers persist by
 * writing it back into context (the webhook pattern). The worker, which owns
 * a mutable reference, may cast instead — its writes are still key-checked.
 */
export function parseRouting(raw: unknown): OfferRouting {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  for (const key of STRING_FIELDS) {
    if (key in out && typeof out[key] !== "string") delete out[key];
  }
  for (const key of NUMBER_FIELDS) {
    if (key in out && typeof out[key] !== "number") delete out[key];
  }
  for (const key of STRING_ARRAY_FIELDS) {
    if (!(key in out)) continue;
    const v = out[key];
    if (Array.isArray(v)) out[key] = v.filter((x): x is string => typeof x === "string");
    else delete out[key];
  }
  if ("last_event" in out && !LAST_EVENTS.includes(out.last_event as string)) {
    delete out.last_event;
  }
  if ("first_to_claim" in out && typeof out.first_to_claim !== "boolean") {
    delete out.first_to_claim;
  }
  if ("late_claim" in out && typeof out.late_claim !== "boolean") delete out.late_claim;
  if ("late_claimed" in out && typeof out.late_claimed !== "boolean") delete out.late_claimed;
  return out as OfferRouting;
}

/** Parse `context.routing` from a run row's context, or null when absent. */
export function routingOfContext(context: Record<string, unknown> | null): OfferRouting | null {
  const raw = context?.routing;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return parseRouting(raw);
}

/**
 * Warning line prepended to an offer SMS when the recipient ALREADY holds at
 * least one other live offer, so they know a single digit only answers the
 * newest one (the Jul 2026 two-leads confusion: Dave replied "1" once and
 * assumed both were his). `totalPending` counts the offer being sent, so it
 * is always >= 2 here.
 */
export function multiOfferHeadsUpLine(totalPending: number): string {
  if (totalPending === 2) {
    return (
      'Heads up: you now have 2 pending offers. Each "1" claims your newest; ' +
      'reply "1" twice to take both.'
    );
  }
  return (
    `Heads up: you now have ${totalPending} pending offers. Each "1" claims ` +
    'your newest; reply "1" once per offer to take them all.'
  );
}
