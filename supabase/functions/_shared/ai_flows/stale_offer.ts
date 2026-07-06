/**
 * Pure classifier + copy for a teammate's STALE offer digit reply.
 *
 * A bare "1"/"2" (or a flow's stamped claim digit) only resumes a run while the
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
   * moved_on          — nobody has claimed it but the offer left the sender
   *                     (escalated to the next agent, or back with the owner).
   */
  kind: "claimed_by_sender" | "claimed_by_other" | "moved_on";
  /** Roster name of the claimer for claimed_by_other ("" when unknown). */
  claimedName: string;
};

function routingOf(row: StaleOfferCandidate): Record<string, unknown> | null {
  const r = row.context?.routing;
  return r && typeof r === "object" ? (r as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Find the most recent routed run (newest-first candidates, same set the
 * late-claim path scans) that this SENDER was ever offered, and classify what
 * their stale digit reply refers to. A run only matches when the digit is an
 * offer digit for THAT run ("1"/"2" always are; a flow's stamped
 * tf_digit/late_digit also count) — otherwise the scan continues to older
 * candidates. Returns null when the reply should fall through to the normal
 * inbound path instead of being consumed:
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
    const routing = routingOf(row);
    if (!routing) continue;
    if (nowMs - Date.parse(row.updated_at) > windowMs) continue;

    const offered = str(routing.offered);
    const tried = Array.isArray(routing.tried)
      ? (routing.tried as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const everOffered =
      offered === from || row.awaiting_agent_e164 === from || tried.includes(from);
    if (!everOffered) continue;

    // Only digits that plausibly reference an offer are consumed: the
    // advertised claim/pass digits plus this flow's stamped extras. A
    // non-matching digit may still reference an OLDER run whose flow stamped
    // that digit (e.g. a late-claim "4" after a newer 1/2-only offer), so keep
    // scanning rather than bailing; a digit no candidate recognizes (e.g. a
    // bare "7") falls through to the normal path.
    const offerDigits = new Set(["1", "2", str(routing.tf_digit), str(routing.late_digit)]);
    if (!offerDigits.has(digit)) continue;

    // A LIVE offer to this sender is the upstream live-claim path's job; when
    // that path didn't consume the digit, don't tell the sender the window
    // passed (it hasn't).
    const liveToSender =
      offered === from && (row.status === "awaiting_agent" || row.status === "queued");
    if (liveToSender) return null;

    const claimedBy = str(routing.claimed_by);
    if (claimedBy === from) {
      return { runId: row.id, kind: "claimed_by_sender", claimedName: "" };
    }
    if (claimedBy) {
      return {
        runId: row.id,
        kind: "claimed_by_other",
        claimedName: str(routing.claimed_name).trim()
      };
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
      return "You've already got this lead — it's yours. Reply 86 if you need to release it.";
    case "claimed_by_other":
      return (
        `Thanks — that lead's claim window has passed and ` +
        `${outcome.claimedName || "another teammate"} picked it up. You'll get the next one.`
      );
    case "moved_on":
      return (
        "Thanks — that lead's claim window has passed, so it moved on to the next step. " +
        "You'll get the next one."
      );
  }
}
