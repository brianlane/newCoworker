/**
 * The closed set of `decision` values recorded on ai_flow_agent_offer_reply
 * telemetry events. One exported const instead of string literals scattered
 * across call sites: a typo can't fork a new decision, and this file doubles
 * as the checklist for any "why did this lead go where it went" view built
 * over telemetry.
 */
export const OFFER_REPLY_DECISION = {
  /** Bare "1" from the currently offered teammate: live claim. */
  claim: "claim",
  /** "1, <eta>" from the currently offered teammate: live claim with ETA. */
  claim_timeframe: "claim_timeframe",
  /** Bare "2" from the currently offered teammate: pass. */
  reject: "reject",
  /** "2, <reason>": pass with the stated reason surfaced to the owner. */
  reject_reason: "reject_reason",
  /** A claim reply that lost the optimistic-concurrency race (sender was texted a correction). */
  claim_raced: "claim_raced",
  /** A "1, <eta>" claim that lost the race. */
  claim_timeframe_raced: "claim_timeframe_raced",
  /** A pass reply that lost the race (logged, no correction text needed). */
  reject_raced: "reject_raced",
  /** "1" re-opened a lapsed run whose post-route steps already ran. */
  late_claim: "late_claim",
  /** "1" claimed a run still parked LIVE at the route step via the late path. */
  late_option_live: "late_option_live",
  /** Duplicate "1"/"86" on a lead the sender already holds: idempotent re-ack. */
  late_claim_repeat: "late_claim_repeat",
  /** A late claim that lost the reopen race. */
  late_claim_raced: "late_claim_raced",
  /** A claim refused because the contact already belongs to another active teammate. */
  claim_owner_conflict: "claim_owner_conflict",
  /** First-to-claim: bare "1" took over an offer live with another teammate. */
  first_to_claim: "first_to_claim",
  /** "86": the claimer released the lead back to the owner. */
  unclaim: "unclaim",
  /** An unclaim that lost the reopen race. */
  unclaim_raced: "unclaim_raced",
  /** Stale-offer ack: the sender already holds the lead. */
  stale_claimed_by_sender: "stale_claimed_by_sender",
  /** Stale-offer ack: someone else picked the lead up. */
  stale_claimed_by_other: "stale_claimed_by_other",
  /** Stale-offer ack: lead is live with another teammate; bare-"1" yank taught. */
  stale_live_with_other: "stale_live_with_other",
  /** Stale-offer ack: the offer moved on (escalated / owner fallback). */
  stale_moved_on: "stale_moved_on",
  /**
   * A reply that could have meant more than one of the sender's live leads
   * (a bare "1" with several pending, or a "1, <name>" whose name fit two).
   * Nothing was claimed; we asked which one. Watch this: a rising count means
   * the offer copy is not teaching the "1, <name>" form well enough.
   */
  claim_ambiguous: "claim_ambiguous",
  /**
   * "1, <name>" naming a lead the sender cannot claim (someone took it, or it
   * is not theirs), where the text is not an ETA either. Nothing was claimed;
   * we said what they still have. Before this existed the reply silently
   * claimed their most-recently-touched lead and stamped the name as an ETA.
   */
  claim_name_unmatched: "claim_name_unmatched",
  /**
   * The owner's "1" after a keep-for-owner park already finished. Nothing
   * re-opens; we said the reminders already stopped. Without this the reply
   * fell through to an unrelated lapsed offer (Jason Ellis, 2026-09-02).
   */
  owner_direct_ack: "owner_direct_ack"
} as const;

export type OfferReplyDecision =
  (typeof OFFER_REPLY_DECISION)[keyof typeof OFFER_REPLY_DECISION];

/** Map a stale-offer classification kind to its telemetry decision. */
export function staleOfferDecision(
  kind: "claimed_by_sender" | "claimed_by_other" | "live_with_other" | "moved_on"
): OfferReplyDecision {
  switch (kind) {
    case "claimed_by_sender":
      return OFFER_REPLY_DECISION.stale_claimed_by_sender;
    case "claimed_by_other":
      return OFFER_REPLY_DECISION.stale_claimed_by_other;
    case "live_with_other":
      return OFFER_REPLY_DECISION.stale_live_with_other;
    case "moved_on":
      return OFFER_REPLY_DECISION.stale_moved_on;
  }
}
