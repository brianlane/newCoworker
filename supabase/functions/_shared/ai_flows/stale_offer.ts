/**
 * Pure classifier + copy for a teammate's STALE offer digit reply.
 *
 * A bare "1"/"2" only resumes a run while the
 * sender is the CURRENTLY offered agent. When the claim window lapses, a late
 * "1" now claims the lead retroactively via the webhook's late-claim path
 * (which runs BEFORE this classifier), so this module only answers the replies
 * that can no longer claim anything: someone else took the lead, the run isn't
 * re-openable, or the digit was a pass. Without it those replies would fall
 * through to the customer-chat AI — which knows nothing about AiFlow offers and
 * improvises a baffling answer ("I can only handle one message at a time").
 * The webhook uses this module to recognize "this teammate is replying to an
 * offer that moved on" and answer deterministically with what actually
 * happened to the lead.
 *
 * Lives in `_shared` (not the telnyx-sms-inbound entrypoint) so it can be unit
 * tested under vitest without booting the Deno HTTP server.
 */
import { routingOfContext } from "./routing.ts";

/** The run-row shape the webhook already reads for late-claim candidate scans. */
export type StaleOfferCandidate = {
  id: string;
  status: string;
  context: Record<string, unknown> | null;
  awaiting_agent_e164: string | null;
  updated_at: string;
};

export type StaleOfferOutcome = {
  runId: string;
  /**
   * claimed_by_sender — the sender already holds this lead (duplicate claim);
   * claimed_by_other  — someone else picked it up after the window lapsed;
   * live_with_other   — unclaimed but actively offered to another teammate,
   *                     and the flow allows first-to-claim: a bare "1" would
   *                     take it over, so tell the sender that instead of
   *                     pretending the lead is gone;
   * moved_on          — nobody has claimed it but the offer left the sender
   *                     (escalated to the next agent, or back with the owner).
   */
  kind: "claimed_by_sender" | "claimed_by_other" | "live_with_other" | "moved_on";
  /** Roster name of the claimer for claimed_by_other ("" when unknown). */
  claimedName: string;
};

/**
 * Find the most recent routed run (newest-first candidates, same set the
 * late-claim path scans) that this SENDER was ever offered, and classify what
 * their stale digit reply refers to. A run only matches when the digit is an
 * offer digit ("1" claim / "2" pass — universal on every flow) — otherwise the
 * scan continues to older candidates. Returns null when the reply should fall
 * through to the normal inbound path instead of being consumed:
 *   - the sender never appeared in a recent offer (a stray digit from staff),
 *   - no candidate run recognizes the digit as one of its offer digits, or
 *   - the first matching run is still LIVE and offered to the sender (the
 *     live-claim path upstream owns that reply; if it declined to consume it,
 *     the digit meant something else).
 */
export function classifyStaleOfferReply(args: {
  candidates: readonly StaleOfferCandidate[];
  from: string;
  digit: string;
  nowMs: number;
  windowMs: number;
}): StaleOfferOutcome | null {
  const { candidates, from, digit, nowMs, windowMs } = args;
  for (const row of candidates) {
    const routing = routingOfContext(row.context);
    if (!routing) continue;
    if (nowMs - Date.parse(row.updated_at) > windowMs) continue;

    const offered = routing.offered ?? "";
    // Broadcast fan-out (route_to_team agentNames): the live offerees are in
    // offered_all (routing.offered stays unset until a claim is consumed);
    // offered_log keeps a broadcast passer recognized after their removal.
    const offeredAll = routing.offered_all ?? [];
    const offeredLogAll = routing.offered_log ?? [];
    const tried = routing.tried ?? [];
    const everOffered =
      offered === from ||
      row.awaiting_agent_e164 === from ||
      tried.includes(from) ||
      offeredAll.includes(from) ||
      offeredLogAll.includes(from);
    if (!everOffered) continue;

    // Only digits that plausibly reference an offer are consumed: "1" (claim)
    // and "2" (pass), universal on every flow. Any other digit (e.g. a bare
    // "7") falls through to the normal path.
    if (digit !== "1" && digit !== "2") continue;

    // A LIVE offer to this sender is the upstream live-claim path's job; when
    // that path didn't consume the digit, don't tell the sender the window
    // passed (it hasn't).
    const liveToSender =
      (offered === from || offeredAll.includes(from)) &&
      (row.status === "awaiting_agent" || row.status === "queued");
    if (liveToSender) return null;

    const claimedBy = routing.claimed_by ?? "";
    if (claimedBy === from) {
      return { runId: row.id, kind: "claimed_by_sender", claimedName: "" };
    }
    if (claimedBy) {
      return {
        runId: row.id,
        kind: "claimed_by_other",
        claimedName: (routing.claimed_name ?? "").trim()
      };
    }
    // Unclaimed but actively offered to another teammate. When the flow allows
    // first-to-claim (the default), a bare "1" would have yanked it upstream in
    // tryLateClaim — reaching this classifier with a "1" means the sender added
    // an ETA ("1, a few hours"), which must not preempt the active countdown.
    // Tell them the bare-"1" affordance instead of pretending the lead is gone.
    // Gated on routing.offered_log (who actually RECEIVED an offer SMS) so a
    // teammate the worker merely skipped is never taught a yank that
    // tryLateClaim would then refuse.
    const offeredLog = routing.offered_log ?? [];
    // "Live with someone else": a single offer with another teammate, OR a
    // broadcast whose remaining offerees no longer include the sender (they
    // passed earlier and were retired from offered_all).
    const liveWithOther =
      ((offered !== "" && offered !== from) ||
        (offeredAll.length > 0 && !offeredAll.includes(from))) &&
      (row.status === "awaiting_agent" || row.status === "queued");
    if (
      liveWithOther &&
      digit === "1" &&
      offeredLog.includes(from) &&
      routing.first_to_claim !== false
    ) {
      return { runId: row.id, kind: "live_with_other", claimedName: "" };
    }
    return { runId: row.id, kind: "moved_on", claimedName: "" };
  }
  return null;
}

/**
 * The confirmation texted back for a consumed stale offer reply. Deterministic
 * copy (never the chat AI): says what happened to the lead and, where useful,
 * what the sender can still do.
 */
export function staleOfferAckText(outcome: StaleOfferOutcome): string {
  switch (outcome.kind) {
    case "claimed_by_sender":
      return "You've already got this lead, it's yours. Reply 86 if you need to release it.";
    case "live_with_other":
      return (
        "That lead is with another teammate right now. If you can take it " +
        'immediately, reply 1 (just "1", no ETA) to claim it.'
      );
    case "claimed_by_other":
      return (
        `Thanks, that lead's claim window has passed and ` +
        `${outcome.claimedName || "another teammate"} picked it up. You'll get the next one.`
      );
    case "moved_on":
      return (
        "Thanks, that lead's claim window has passed, so it moved on to the next step. " +
        "You'll get the next one."
      );
  }
}
