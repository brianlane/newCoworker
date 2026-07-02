/**
 * Per-contact SMS reply mode (contacts.sms_reply_mode) — shared logic for the
 * sms-inbound-worker gate and the telnyx-sms-inbound owner-reply routing.
 *
 * 'auto'          → default Coworker reply (unchanged behavior).
 * 'suppress'      → no default reply. AiFlows, logging, interaction counters
 *                   and manual dashboard sends are unaffected.
 * 'forward_owner' → no default reply; forward the text to the owner's cell
 *                   with "What would you like me to say?" and relay the
 *                   owner's next reply back to the customer.
 *
 * Kept dependency-free so it is importable from Vitest (Node) and Deno alike.
 */

export const SMS_REPLY_MODES = ["auto", "suppress", "forward_owner"] as const;
export type SmsReplyMode = (typeof SMS_REPLY_MODES)[number];

/** Sanitize a DB value; anything unknown degrades to 'auto' (fail-open to today's behavior). */
export function resolveSmsReplyMode(value: unknown): SmsReplyMode {
  return SMS_REPLY_MODES.includes(value as SmsReplyMode) ? (value as SmsReplyMode) : "auto";
}

/**
 * How long an unanswered "what would you like me to say?" prompt stays
 * routable. An owner text after this window is treated as a normal staff
 * message (internal assistant), never relayed to a customer — bounding the
 * blast radius of a stale prompt.
 */
export const OWNER_REPLY_PROMPT_FRESHNESS_MS = 6 * 60 * 60 * 1000;

export function isPromptFresh(createdAtIso: string, nowMs: number): boolean {
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) return false;
  return nowMs - created <= OWNER_REPLY_PROMPT_FRESHNESS_MS;
}

/**
 * The forward the owner receives. Mirrors the Safe-Mode forward truncation
 * contract: inbound body capped at 1000 chars, final SMS capped at 1600.
 */
export function buildOwnerReplyPromptSms(args: {
  /** Contact display name when known, else the E.164. */
  customerLabel: string;
  inboundText: string;
}): string {
  const body = args.inboundText.slice(0, 1000);
  return `[Reply needed] ${args.customerLabel}: ${body}\n\nWhat would you like me to say? Reply here and I'll send it to them.`.slice(
    0,
    1600
  );
}

/** Confirmation the owner gets after their reply is relayed. */
export function buildOwnerReplyAck(customerLabel: string): string {
  return `Sent to ${customerLabel}.`.slice(0, 1600);
}

/**
 * Owner replies that must NEVER be relayed to a customer even when a prompt is
 * pending: bare digits are approval/claim vocabulary (handled earlier in the
 * webhook, but a digit with no pending approval would otherwise fall through
 * to the relay), and "86" is the unclaim keyword. Compliance keywords
 * (STOP/HELP/START) are intercepted before this check ever runs.
 */
export function isRelayableOwnerReply(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0) return false;
  if (/^\d{1,2}$/.test(trimmed)) return false;
  return true;
}
