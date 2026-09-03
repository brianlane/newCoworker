/**
 * THE routing contract: the shape of `context.routing` on a route_to_team run.
 *
 * The inbound webhook (telnyx-sms-inbound) and the engine (ai-flow-worker)
 * communicate exclusively through this object, one stamps, the other reads,
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
   * NEVER set while a BROADCAST offer is live (offered_all below), the two
   * modes are mutually exclusive so single-offer code paths stay inert on a
   * broadcast run. The webhook DOES stamp `offered` = the claimer when it
   * consumes a broadcast claim, which is what hands the run to the worker's
   * existing claim finalization.
   */
  offered?: string;
  /** Roster name for `offered`. Same lifecycle as `offered`. */
  offered_name?: string;
  /**
   * BROADCAST mode (route_to_team `agentNames`): E.164s of EVERY teammate the
   * offer is currently live with, all sharing one deadline, first "1" wins.
   * Set: worker on fan-out. Shrinks: webhook removes a passing teammate on
   * their "2". Cleared: WORKER when finalizing a claim (it reads the losing
   * offerees off this list to text them a courtesy notice first) and on
   * timeout/all-passed owner fallback.
   */
  offered_all?: string[];
  /**
   * Roster names for `offered_all`, keyed by E.164. Set alongside offered_all
   * and kept through the claim (the worker reads the claimer's + losers'
   * names from it while finalizing). Cleared with offered_all when the worker
   * finalizes a claim/timeout; harmless to persist otherwise.
   */
  offered_names?: Record<string, string>;
  /**
   * The broadcast offer's shared claim deadline (epoch ms). Set: worker on
   * fan-out. Read: worker to re-park with the REMAINING time after a "2"
   * retired one offeree (the webhook nulls respond_by_at on every resume).
   * Cleared: worker when finalizing a claim/timeout/all-passed fallback.
   */
  offer_deadline_ms?: number;
  /**
   * E.164s that were actually TEXTED an offer for this lead, in order.
   * Set: worker appends on every offer send (and backfills the retiring agent
   * for runs that predate the field). Never cleared, survives the claim.
   * This is the eligibility list for the first-to-claim yank; `tried` is NOT
   * (it also collects opt-out/lead-phone skips that never saw an offer).
   */
  offered_log?: string[];
  /**
   * E.164s already consumed by the escalation loop (offered agents AND
   * skipped ones). Set: worker on retire/skip; webhook adds the preempted
   * teammate on a yank. Never cleared, survives the claim.
   */
  tried?: string[];
  /**
   * How many unclaimed-lead reminder rounds have already gone out on this
   * offer (route_to_team `unclaimedReminders`). Set: worker, incremented on
   * each round. Read: worker, to decide between another round and handing the
   * lead to the owner. Cleared with the rest of the offer state when the run
   * finalizes. Absent/0 means no reminder has been sent yet.
   */
  reminder_rounds?: number;
  /**
   * E.164s that explicitly PASSED this lead ("2" / "2, <reason>"), as opposed
   * to the ones that simply never answered. `tried` cannot serve this purpose:
   * it also collects timeouts, opt-out skips, and lead-phone skips. Set:
   * worker, when it folds a reject. Never cleared while the offer lives.
   *
   * Read by the unclaimed-lead reminder ladder, which nudges silence only: a
   * teammate who said no has answered, and asking them three more times is
   * noise.
   */
  passed_by?: string[];
  /**
   * E.164 of the teammate who holds the lead. Set: worker when finalizing a
   * claim. Cleared: worker on an unclaim ("86"). Gates every claim path:
   * a lead claimed by someone else is never re-claimable.
   */
  claimed_by?: string;
  /** Roster name for `claimed_by`. Same lifecycle. */
  claimed_name?: string;
  /**
   * WHEN the claim landed, epoch ms. Stamped alongside `claimed_by` at every
   * site that sets it: the worker's claim finalization ("1" consumed), the
   * auto-assign and owner-assign hard assignments, and the dashboard claim
   * helper (src/lib/leads/claim-stamp.ts). Cleared with `claimed_by` on an
   * unclaim ("86") so a later re-claim gets a fresh stamp. Read by
   * employee-performance analytics as the REAL claim moment; runs from
   * before this field exist without it and the analytics fall back to an
   * approximation, so absence means "legacy run", never "not claimed".
   * NOTE: unrelated to the `ai_flow_runs.claimed_at` COLUMN, which is the
   * worker's queue lease, not the lead claim.
   */
  claimed_at_ms?: number;
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
   * The route_to_team step's ID, the definition-edit-proof companion to
   * route_step_index. The webhook rewinds restore it as the run's resume
   * marker (RESUME_STEP_ID_VAR) so a rewound run relocates correctly even if
   * the flow was edited while parked. Set: worker when the route step
   * executes. Never cleared.
   */
  route_step_id?: string;
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
   * worker. Never cleared, appended to the owner-fallback SMS and kept as
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
   * Permanent "this claim came from lead auto-assignment" marker
   * (businesses.lead_auto_assign): the worker hard-assigned the rotation pick
   * without an offer/claim handshake, so no offer was ever live and the
   * webhook's claim/yank machinery never applied. Set: worker. Never cleared.
   */
  auto_assigned?: boolean;
  /**
   * The contact already had an ACTIVE owning teammate, so the route step
   * assigned the lead to them instead of racing the roster (see
   * finalizeOwnerAssigned). Like auto_assigned: no live offer ever existed,
   * so the webhook's claim/yank machinery never applied. Set: worker.
   * Never cleared.
   */
  owner_assigned?: boolean;
  /**
   * Keep-for-owner nudge park (ownerDirectNudges): this awaiting_agent park
   * is the OWNER acknowledging a high-value alert, NOT a teammate offer. The
   * worker's owner-direct resume handler consumes every event on such a run
   * (a "1" is an ack that stops the reminders, never a claim), and the
   * roster escalation loop is never entered. Set: worker when it parks the
   * owner-direct alert. Never cleared (owner_direct_done marks completion).
   */
  owner_direct?: boolean;
  /**
   * How many owner-direct reminders have gone out (0 → the 10-minute nudge
   * is next; 1 → the 30-minute final nudge is next). Set: worker.
   */
  owner_nudges?: number;
  /**
   * Permanent "the owner-direct park finished" marker (acked or nudges
   * exhausted). Set: worker on finalize. Never cleared.
   */
  owner_direct_done?: boolean;
  /**
   * The owner's forward number this keep-for-owner alert was parked on.
   * Set: worker alongside `owner_direct`. Never cleared (unlike `offered`,
   * which finalize() deletes). The late-claim matcher uses it to absorb a
   * stray owner "1" after the park ends, instead of falling through to an
   * unrelated lapsed offer (Jason Ellis, 2026-09-02).
   */
  owner_direct_e164?: string;
  /**
   * The roster is exactly one ACTIVE member and that member is provably the
   * business owner (solo_owner.ts), so the route step sent one informational
   * notice instead of running an offer race. No live offer ever existed
   * (offered/offered_log stay unset) and nothing was claimed (claimed_by
   * stays unset), so the webhook's claim/pass/unclaim machinery never
   * applies to such a run. Set: worker. Never cleared.
   */
  solo_owner?: boolean;
  /**
   * LEGACY (pre-universal-digits). No longer set anywhere; the worker scrubs
   * them from stored runs on retire/claim so old stamps can't linger.
   * @deprecated
   */
  tf_digit?: string;
  /** LEGACY, see tf_digit. @deprecated */
  late_digit?: string;
};

const STRING_ARRAY_FIELDS = [
  "offered_log",
  "tried",
  "pass_reasons",
  "offered_all",
  "passed_by"
] as const;
const STRING_FIELDS = [
  "offered",
  "offered_name",
  "claimed_by",
  "claimed_name",
  "reply_from",
  "claim_timeframe",
  "pass_reason",
  "route_step_id",
  "owner_direct_e164"
] as const;
const NUMBER_FIELDS = [
  "step_index",
  "route_step_index",
  "owner_nudges",
  "offer_deadline_ms",
  "claimed_at_ms"
] as const;
const LAST_EVENTS: readonly string[] = ["claim", "reject", "timeout", "unclaim"];

/**
 * Normalize a raw `context.routing` value into a typed SHALLOW COPY.
 *
 * - Unknown/legacy keys are preserved at runtime (spread first) so a
 *   parse → mutate → persist round-trip never drops data a newer or older
 *   deploy stamped, but they are invisible to the type, so WRITES to
 *   misspelled fields are compile errors.
 * - Malformed values (wrong JSON type) are dropped rather than trusted, so
 *   readers never need inline `typeof` guards again.
 *
 * Mutating the returned object never mutates the source; callers persist by
 * writing it back into context (the webhook pattern). The worker, which owns
 * a mutable reference, may cast instead, its writes are still key-checked.
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
  if ("offered_names" in out) {
    const v = out.offered_names;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const clean: Record<string, string> = {};
      for (const [k, name] of Object.entries(v as Record<string, unknown>)) {
        if (typeof name === "string") clean[k] = name;
      }
      out.offered_names = clean;
    } else {
      delete out.offered_names;
    }
  }
  if ("last_event" in out && !LAST_EVENTS.includes(out.last_event as string)) {
    delete out.last_event;
  }
  if ("first_to_claim" in out && typeof out.first_to_claim !== "boolean") {
    delete out.first_to_claim;
  }
  if ("late_claim" in out && typeof out.late_claim !== "boolean") delete out.late_claim;
  if ("late_claimed" in out && typeof out.late_claimed !== "boolean") delete out.late_claimed;
  if ("auto_assigned" in out && typeof out.auto_assigned !== "boolean") {
    delete out.auto_assigned;
  }
  if ("owner_direct" in out && typeof out.owner_direct !== "boolean") {
    delete out.owner_direct;
  }
  if ("owner_direct_done" in out && typeof out.owner_direct_done !== "boolean") {
    delete out.owner_direct_done;
  }
  if ("solo_owner" in out && typeof out.solo_owner !== "boolean") {
    delete out.solo_owner;
  }
  return out as OfferRouting;
}

/** Parse `context.routing` from a run row's context, or null when absent. */
export function routingOfContext(context: Record<string, unknown> | null): OfferRouting | null {
  const raw = context?.routing;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return parseRouting(raw);
}

/**
 * Line prepended to an offer SMS when the recipient ALREADY holds at least
 * one other live offer. `totalPending` counts the offer being sent, so it is
 * always >= 2 here.
 *
 * This used to read 'Each "1" claims your newest; reply "1" twice to take
 * both', which described the ambiguity rather than removing it, and was not
 * even reliably true: a bare digit answers the most recently UPDATED run, and
 * an escalation re-park or quiet-hours deferral can move an older lead to the
 * front. Since Aug 2026 the reply carries the lead's name instead, matched
 * partially against the teammate's own live leads (see
 * `matchOfferByLeadName`), so the instruction is now specific and correct.
 *
 * `leadShortName` is the lead's first name; when a flow never captured a
 * name, the copy falls back to counting the leads without promising a reply
 * shape that cannot work.
 */
export function multiOfferHeadsUpLine(totalPending: number, leadShortName: string): string {
  const count = `*You have ${totalPending} unclaimed leads.*`;
  if (!leadShortName.trim()) {
    return `${count} Reply "1, <name>" to say which one you are claiming.`;
  }
  return `${count} Reply "1, ${leadShortName.trim()}" for this one.`;
}
