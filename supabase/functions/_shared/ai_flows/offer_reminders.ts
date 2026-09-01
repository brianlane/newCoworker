/**
 * Reminder rounds between an offer lapsing and the owner inheriting it.
 *
 * Before this, a broadcast offer that nobody claimed went straight to the
 * owner the moment the deadline passed (`routeBroadcastStep`'s timeout arm
 * called `ownerFallbackOutcome` directly). Amy's ask, Aug 2026: nudge the
 * team three more times first, twenty minutes apart, and only then hand it
 * over. The team is who should work the lead; the owner is the backstop.
 *
 * Deliberately COMPACT copy rather than a re-send of the offer. Amy's Clever
 * offer body is the whole referral blob, around 1,500 characters, which
 * Telnyx bills as roughly ten segments. Re-sending it three more times to
 * every recipient would multiply the messaging cost of an unclaimed lead by
 * four for no new information: the teammate already has the details in the
 * thread above. A reminder's job is to say "still unclaimed, here is which
 * lead, here is how to take it, here is what happens next".
 *
 * Pure and dependency-free so vitest can pin the exact wording.
 */

/** Amy's ask: three nudges, then the owner. */
export const DEFAULT_REMINDER_ROUNDS = 3;
/** Amy's ask: twenty minutes apart. */
export const DEFAULT_REMINDER_INTERVAL_MINUTES = 20;

/**
 * The final round leads with this instead of asterisk emphasis. Asterisks are
 * literal characters on plain SMS (they render as bold only on RCS), so the
 * last message needs a marker that reads as urgent on every handset.
 */
export const FINAL_REMINDER_BANNER = "‼️‼️‼️‼️‼️";

export type ReminderConfig = {
  /** How many reminder rounds fire before the owner inherits the lead. */
  rounds: number;
  /** Minutes between rounds, and between the last round and the handover. */
  intervalMinutes: number;
};

/**
 * Strip `*emphasis*` pairs. The final reminder trades the asterisks for the
 * banner, so any starring carried in from the flow's own copy has to come off
 * too or the message ends up wearing both. Only matched pairs on one line are
 * touched: a lone asterisk (a bullet, a footnote) is left exactly as typed.
 */
export function stripEmphasis(text: string): string {
  return text.replace(/\*([^*\n]+)\*/g, "$1");
}

export type ReminderTextArgs = {
  /** Display name of the lead, e.g. "Daniel Villanueva". "" when unknown. */
  leadLabel: string;
  /** Lead phone for the header line. "" when unknown. */
  leadPhone: string;
  /** 1-based round number. */
  round: number;
  /** Total rounds configured, so the copy can count down honestly. */
  rounds: number;
  /** Minutes until the next round (or until the owner inherits it). */
  intervalMinutes: number;
  /** What the owner is called in the handover warning, e.g. "Amy". */
  ownerLabel: string;
  /**
   * Flow-authored compact context, already rendered, e.g. "Lead type: seller".
   * Omitted when the step configured none.
   */
  details?: string;
  /**
   * How to claim. Carries the lead's name when the teammate has more than one
   * lead pending, so the reply is unambiguous.
   */
  claimHint: string;
};

/** "Daniel Villanueva (+14802949456)", degrading as facts are missing. */
function leadHeader(label: string, phone: string): string {
  if (label && phone) return `${label} (${phone})`;
  if (label) return label;
  if (phone) return phone;
  return "This lead";
}

/**
 * One reminder message. Rounds before the last carry asterisk emphasis and
 * count themselves ("REMINDER 2 of 3"); the last leads with the banner, drops
 * every asterisk, and names who it goes to next.
 */
export function reminderText(args: ReminderTextArgs): string {
  const isFinal = args.round >= args.rounds;
  const header = leadHeader(args.leadLabel, args.leadPhone);
  const detailBlock = args.details?.trim() ? `${args.details.trim()}\n` : "";
  const handover = args.ownerLabel || "the owner";

  if (isFinal) {
    const body =
      `${FINAL_REMINDER_BANNER}\n` +
      `FINAL REMINDER: ${header} is still unclaimed.\n` +
      detailBlock +
      `\n${args.claimHint}\n` +
      `No answer in ${args.intervalMinutes} minutes and this goes to ${handover}.`;
    // The banner carries the urgency now, so nothing else wears asterisks.
    return stripEmphasis(body);
  }

  return (
    `*REMINDER ${args.round} of ${args.rounds}*: ${header} is *still unclaimed*.\n` +
    detailBlock +
    `\n${args.claimHint}\n` +
    `Another reminder in ${args.intervalMinutes} minutes.`
  );
}

/**
 * How to claim, given how many leads this teammate is holding. With one lead
 * a bare digit is unambiguous; with more, the name is what makes the reply
 * mean something. The typed reply is quoted, not starred: asterisks around
 * the digit are what teammates copy back, and those used to miss the parser
 * (Jason Lane, 2026-08-31). Count emphasis on "N unclaimed leads" stays.
 */
export function reminderClaimHint(pendingForAgent: number, leadShortName: string): string {
  if (pendingForAgent > 1 && leadShortName) {
    return (
      `You have *${pendingForAgent} unclaimed leads*. ` +
      `Reply "1, ${leadShortName}" to claim this one.`
    );
  }
  return "Reply 1 to claim it.";
}

/**
 * Resolve the configured ladder against a round counter already on the run.
 * Returns the round to SEND now, or null when the ladder is spent and the
 * owner should inherit the lead.
 */
export function nextReminderRound(
  completedRounds: number,
  config: ReminderConfig
): number | null {
  if (config.rounds <= 0) return null;
  const next = completedRounds + 1;
  return next <= config.rounds ? next : null;
}
