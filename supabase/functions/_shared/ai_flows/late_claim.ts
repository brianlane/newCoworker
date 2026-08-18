/**
 * Pure matcher for a teammate's "1" claim reply against recent routed runs:
 * the precedence engine behind live claims, true late (retroactive) claims,
 * the first-to-claim yank, and the idempotent "already yours" re-ack.
 *
 * The webhook (telnyx-sms-inbound tryLateClaim) pre-fetches the candidate
 * rows and EXECUTES the decision this function returns; all of the business
 * logic, eligibility, bucket precedence, the bare-"1"-only yank rule, lives
 * here where vitest can pin it down. Same pattern as stale_offer.ts.
 *
 * This path also honors a NAMED claim ("1, Aurora Anthony"). The live-offer
 * path in the webhook has read names since PR #1270, but it only looks at runs
 * still parked at the route step, so once an offer lapses the name had nowhere
 * to be read and fell through to the ETA reading. Observed on Amy Laidlaw
 * 2026-08-17: a teammate answered "1, Aurora Anthony" three hours after
 * Aurora's offer had completed, and the reply claimed an unrelated lead whose
 * run a sleep step had touched more recently, then texted the owner
 * "ETA to contact lead: Aurora Anthony". Recency is not a safe tiebreak when
 * the sender told us which lead they meant.
 */
import {
  leadLabelFromVars,
  leadPhoneFromVars,
  matchOfferByLeadName,
  normalizeLeadName,
  type OfferCandidate
} from "./offer_identity.ts";
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
   * live, the sender's own active offer (any "1" form claims);
   * late, a lapsed offer whose post-route steps already ran (re-open,
   *        claim/notify only, no step replay);
   * yank, first-to-claim: an offer live with ANOTHER teammate that this
   *        sender was texted earlier; bare "1" only;
   * mine, the sender already holds this lead (idempotent re-ack).
   */
  kind: "live" | "late" | "yank" | "mine";
  row: LateClaimCandidate;
  /** Rewind target (routing.step_index); -1 for "mine" (nothing re-opens). */
  stepIndex: number;
  /**
   * Set when the comma'd text resolved to THIS lead's name instead of an ETA.
   * The caller must not stamp it as `routing.claim_timeframe`: doing so texts
   * the owner "ETA to contact lead: <a person's name>" and zeroes
   * `claimed_agent_eta_minutes`, which also disables the first-to-claim yank.
   */
  namedLabel?: string;
};

/**
 * What a "1" reply resolved to. Ambiguity is its own outcome rather than a
 * null: naming two leads that both answer to what was typed must ASK, and a
 * null would instead fall through to the stale-offer ack.
 */
export type LateClaimResolution =
  | {
      outcome: "match";
      match: LateClaimMatch;
      /**
       * Lead name to confirm back ("Got it, <name> is yours"). Set only when
       * the sender NAMED a lead and had more than one to choose from, which
       * is the live path's rule too: with a single candidate they already
       * know what they took, and acking every claim would add a text per lead
       * per tenant.
       */
      ackLabel?: string;
    }
  | { outcome: "ambiguous"; labels: string[] }
  | { outcome: "none" };

/** Bucket precedence as a sortable rank: live → late → yank → mine. */
const KIND_RANK: Record<LateClaimMatch["kind"], number> = {
  live: 0,
  late: 1,
  yank: 2,
  mine: 3
};

/**
 * Eligibility for ONE candidate, independent of what else is pending.
 *
 * The yank bucket is decided here WITHOUT the no-ETA guard; selection applies
 * it, because the guard exists to stop an ETA ("not right now") from
 * preempting someone's live countdown, and a resolved lead NAME is not an ETA.
 */
function classifyCandidate(args: {
  row: LateClaimCandidate;
  from: string;
  digit: string;
  nowMs: number;
  windowMs: number;
}): LateClaimMatch | null {
  const { row, from, digit, nowMs, windowMs } = args;
  const routing = routingOfContext(row.context);
  if (!routing) return null;
  if (nowMs - Date.parse(row.updated_at) > windowMs) return null;
  // "1" is the universal claim digit; no other digit ever (late-)claims.
  if (digit !== "1") return null;
  const claimedBy = routing.claimed_by ?? "";
  // Claimed by someone else → not available to this teammate.
  if (claimedBy && claimedBy !== from) return null;
  // Already this teammate's lead (claimed via an earlier "1"): re-ack without
  // re-opening. The worker clears routing.step_index when it finalizes a
  // claim, so this idempotent path must NOT require step_index.
  if (claimedBy === from) return { kind: "mine", row, stepIndex: -1 };
  // A fresh claim needs the rewind target the worker stamped on park.
  const stepIndex = routing.step_index ?? -1;
  if (stepIndex < 0) return null;
  const offered = routing.offered ?? "";
  // Broadcast fan-out (route_to_team agentNames): the live offerees are in
  // offered_all (routing.offered stays unset until a claim is consumed).
  const offeredAll = routing.offered_all ?? [];
  // offered_log covers the gap between a broadcast pass (webhook removes the
  // passer from offered_all) and the worker retiring them into tried,
  // everyone actually TEXTED an offer stays eligible here.
  const offeredLog = routing.offered_log ?? [];
  const tried = routing.tried ?? [];
  const everOffered =
    offered === from ||
    row.awaiting_agent_e164 === from ||
    tried.includes(from) ||
    offeredAll.includes(from) ||
    offeredLog.includes(from);
  if (!everOffered) return null;
  // Did the steps AFTER route_to_team already run? They did if the run
  // completed (status "done") OR the worker advanced current_step past the
  // route step (owner fallback ran later steps, then parked on e.g. a
  // quiet-hours defer or approval gate). Those are TRUE late claims.
  const currentStep = typeof row.current_step === "number" ? row.current_step : stepIndex;
  if (row.status === "done" || currentStep > stepIndex) return { kind: "late", row, stepIndex };
  // Still a LIVE offer parked at the route step (later steps not run yet). A
  // broadcast offeree (offered_all) counts as live exactly like a single
  // offeree: any "1" form claims their own live offer.
  if (offered === from || offeredAll.includes(from)) return { kind: "live", row, stepIndex };
  // First-to-claim yank: offered_log only (`tried` also collects skips), and
  // never when the flow opted out.
  if (offeredLog.includes(from) && routing.first_to_claim !== false) {
    return { kind: "yank", row, stepIndex };
  }
  return null;
}

/**
 * The lead a candidate run is about, for name matching. `leadPhone` is always
 * a string here (the var readers return "" when a flow captured no phone), so
 * callers never need a fallback.
 */
function offerCandidateOf(m: LateClaimMatch): OfferCandidate & { leadPhone: string } {
  const vars = (m.row.context?.vars ?? {}) as Record<string, unknown>;
  return {
    runId: m.row.id,
    leadLabel: leadLabelFromVars(vars),
    leadPhone: leadPhoneFromVars(vars)
  };
}

/**
 * Collapse runs that are about the SAME lead down to the best single run.
 *
 * Amy's networks chain several flows per lead (the Clever filing run, the
 * reply-reaction run, the follow-up run), and each one that carries a route
 * step stamps `context.routing`, so one lead routinely owns two or three
 * eligible rows. Without this, naming that lead reports an ambiguity whose
 * question is unanswerable ("Which one? Aurora Anthony or Aurora Anthony?").
 *
 * Grouping is by folded NAME first, and the phone only splits a group when it
 * actually can. Keying on name+phone directly looked tidier but broke on the
 * real data: the flows in a chain do not all capture a phone (the no-phone
 * guard path leaves `lead_phone` empty or "none"), so one lead's runs would
 * land under different keys and produce the very question this exists to
 * prevent, now half-labelled: "Aurora Anthony (...0022) or Aurora Anthony".
 *
 * So, within one name:
 * - zero or one distinct phone → one lead, collapse it,
 * - two or more distinct phones → genuinely different people sharing a name,
 *   split by phone so the last four digits can tell them apart, and keep the
 *   phone-less runs as one further entry, because they could belong to either
 *   and guessing is the failure being avoided.
 */
function collapseByLead(matches: readonly LateClaimMatch[]): LateClaimMatch[] {
  /** Input position, kept so the output stays in newest-first order. */
  type Placed = { at: number; match: LateClaimMatch; phone: string };
  const unnamed: Placed[] = [];
  const byName = new Map<string, Placed[]>();
  matches.forEach((match, at) => {
    const c = offerCandidateOf(match);
    const placed: Placed = { at, match, phone: c.leadPhone.replace(/\D/g, "") };
    const folded = normalizeLeadName(c.leadLabel);
    // An unnamed run can never answer to a name, so it is never merged with
    // another unnamed one: keep it distinct.
    if (!folded) {
      unnamed.push(placed);
      return;
    }
    const group = byName.get(folded);
    if (group) group.push(placed);
    else byName.set(folded, [placed]);
  });

  // Best of a bucket: the strongest claim shape, and among equals the newest
  // (candidates arrive newest-first, so that is the lowest input position).
  const best = (bucket: Placed[]): Placed =>
    bucket.reduce((a, b) => (KIND_RANK[b.match.kind] < KIND_RANK[a.match.kind] ? b : a));

  const picked: Placed[] = [...unnamed];
  for (const group of byName.values()) {
    const phones = new Set(group.map((p) => p.phone).filter((p) => p !== ""));
    if (phones.size <= 1) {
      picked.push(best(group));
      continue;
    }
    const byPhone = new Map<string, Placed[]>();
    for (const p of group) {
      const bucket = byPhone.get(p.phone);
      if (bucket) bucket.push(p);
      else byPhone.set(p.phone, [p]);
    }
    for (const bucket of byPhone.values()) picked.push(best(bucket));
  }
  return picked.sort((a, b) => a.at - b.at).map((p) => p.match);
}

/**
 * Resolve a "1" reply against the candidate runs (newest-first, same set the
 * stale classifier scans).
 *
 * Two ways a reply resolves:
 *
 * 1. **By NAME.** When the comma'd text names one of the leads the sender
 *    could claim, that lead wins outright, whatever its bucket and whatever
 *    was touched most recently. Naming two different leads that both answer
 *    to the text asks instead of guessing. A text that names nothing is an
 *    ETA and falls through to (2) unchanged, so "1, 20 min" keeps its meaning.
 * 2. **By PRECEDENCE**, not raw recency: live → late → yank → mine. Within a
 *    bucket the newest candidate wins.
 *
 * Returns outcome "none" when nothing is claimable so the caller can fall
 * through (stale-offer ack → normal inbound path).
 *
 * Rules pinned here (see tests):
 * - Only digit "1" ever matches, the universal claim digit.
 * - A run claimed by someone else never matches; claimed by the sender is
 *   the "mine" re-ack.
 * - A fresh claim needs routing.step_index (the worker's rewind stamp).
 * - live: the sender IS routing.offered (or one of the broadcast offerees in
 *   routing.offered_all) and post-route steps haven't run.
 * - late: post-route steps already ran (status done, or current_step moved
 *   past the route step) and the sender was ever offered the lead.
 * - yank: the offer is live with another teammate; the sender is in
 *   routing.offered_log (actually TEXTED an offer, `tried` also collects
 *   skips); the flow didn't opt out (routing.first_to_claim === false); and
 *   the reply carries no ETA. A NAMED reply may yank, because the guard is
 *   about ETAs ("not right now") and naming a lead is the opposite: it says
 *   this exact lead, now.
 */
export function matchLateClaimReply(args: {
  candidates: readonly LateClaimCandidate[];
  from: string;
  digit: string;
  /** Comma'd free text of the reply, "" for a bare digit. */
  timeframe: string;
  nowMs: number;
  windowMs: number;
}): LateClaimResolution {
  const { candidates, from, digit, timeframe, nowMs, windowMs } = args;
  const typed = timeframe.trim();

  if (typed) {
    const eligible = collapseByLead(
      candidates
        .map((row) => classifyCandidate({ row, from, digit, nowMs, windowMs }))
        .filter((m): m is LateClaimMatch => m !== null)
    );
    const named = matchOfferByLeadName(
      // The matcher treats the id as opaque, so the position in `eligible` is
      // the most useful thing to put there: it makes the lookup back a total
      // index rather than a search that would need an impossible miss handled.
      eligible.map((m, i) => ({ ...offerCandidateOf(m), runId: String(i) })),
      typed
    );
    if (named.kind === "ambiguous") return { outcome: "ambiguous", labels: named.labels };
    if (named.kind === "one") {
      const hit = eligible[Number(named.runId)];
      return {
        outcome: "match",
        match: { ...hit, namedLabel: named.label },
        ...(eligible.length > 1 ? { ackLabel: named.label } : {})
      };
    }
    // Named nothing: the text is an ETA after all. Fall through unchanged.
  }

  const match = pickByPrecedence({ candidates, from, digit, timeframe, nowMs, windowMs });
  return match ? { outcome: "match", match } : { outcome: "none" };
}

/**
 * The original recency-and-precedence pick, used for a bare "1" and for a
 * comma'd text that named no lead. Scanning stops as soon as all four buckets
 * are filled: candidates are newest-first, so nothing later can win.
 */
function pickByPrecedence(args: {
  candidates: readonly LateClaimCandidate[];
  from: string;
  digit: string;
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
    const m = classifyCandidate({ row, from, digit, nowMs, windowMs });
    if (!m) continue;
    if (m.kind === "mine") {
      if (!mine) mine = m;
    } else if (m.kind === "late") {
      if (!late) late = m;
    } else if (m.kind === "live") {
      if (!live) live = m;
    } else if (!yank && timeframe === "") {
      // An ETA means "not right now" and must not preempt another teammate's
      // active countdown. Only a bare "1" yanks here; a NAMED reply is
      // resolved before this function is reached.
      yank = m;
    }
  }

  return live ?? late ?? yank ?? mine;
}
