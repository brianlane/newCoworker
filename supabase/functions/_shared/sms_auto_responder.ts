/**
 * Detect inbound SMS that no human wrote: platform auto-responders and
 * machine-repeated notices. The counterpart of `sms_tapback.ts`, and the
 * suppression branch in sms-inbound-worker consumes it the same way.
 *
 * Why this exists (Amy Laidlaw, 2026-08-07): HomeLight's automated feedback
 * number was saved as a customer contact, so the coworker replied to its
 * robotic "Great job connecting with Eugene!" text. That reply triggered
 * HomeLight's auto-responder ("This phone number is not monitored..."),
 * the coworker politely replied to THAT, and the two machines thanked each
 * other every ~30 seconds while every lap fired an urgent owner alert, by
 * SMS and email, at the business owner. Seventeen laps before a human
 * intervened.
 *
 * A reply loop between two bots needs both sides to keep talking. This
 * module is how our side stops: an inbound that is (a) worded like an
 * auto-responder, (b) a near-verbatim repeat of what the same sender
 * already sent, or (c) a transport duplicate of a text received seconds
 * earlier gets no generated reply, which starves the other robot of
 * anything to answer.
 *
 * Pure functions only: no I/O, no clock, no Deno globals, so the whole
 * module unit-tests at 100% like every `_shared` module.
 */

/**
 * Phrases that essentially only occur in machine-generated SMS. Matched
 * against a whitespace-collapsed, lowercased body. Deliberately narrow: a
 * human can type "I'm driving, will reply later", so things like generic
 * out-of-office wording stay OFF this list. The repeat detector below
 * catches what the phrase list conservatively misses, because a human never
 * sends the identical sentence five times at machine cadence.
 */
const AUTO_RESPONDER_PATTERNS: readonly RegExp[] = [
  // The exact family from the incident: "This phone number is not monitored."
  /\b(?:phone\s+)?number\s+is\s+not\s+monitored\b/,
  /\bthis\s+(?:inbox|number|line)\s+is\s+(?:un|not\s+)monitored\b/,
  /\bnot\s+a\s+monitored\s+(?:number|inbox|line)\b/,
  /\bdo\s+not\s+(?:reply|respond)\s+to\s+this\s+(?:message|text|number|email)\b/,
  /\bthis\s+is\s+an\s+automated\s+(?:message|text|response|reply|notification)\b/,
  /\bautomated\s+(?:message|response|reply)[.,\s]+(?:please\s+)?do\s+not\s+reply\b/,
  /\byou(?:\s+are|'re)\s+receiving\s+this\s+automated\b/,
  /\bthis\s+number\s+(?:cannot|can\s*not|can't)\s+(?:receive|accept)\s+(?:replies|messages|texts)\b/,
  /\breplies\s+(?:to\s+this\s+number\s+)?are\s+not\s+(?:monitored|read|received)\b/
];

/** Collapse the shapes that vary between sends of the SAME robotic text. */
export function normalizeSmsFingerprint(text: string): string {
  return text
    .toLowerCase()
    // Smart quotes render differently across gateways; flatten them so the
    // same notice fingerprints identically however it was re-encoded.
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the text is worded like a machine's do-not-reply notice. */
export function looksLikeAutoResponder(text: string): boolean {
  const normalized = normalizeSmsFingerprint(text);
  if (normalized.length === 0) return false;
  return AUTO_RESPONDER_PATTERNS.some((p) => p.test(normalized));
}

/**
 * How many of the sender's recent messages are the same text as this one,
 * after normalization. Trailing links are ignored when comparing, because
 * notice generators love appending per-send tracking URLs to an otherwise
 * fixed sentence.
 */
export function countIdenticalRecent(recentBodies: readonly string[], incoming: string): number {
  const strip = (t: string): string =>
    normalizeSmsFingerprint(t).replace(/https?:\/\/\S+/g, "").trim();
  const target = strip(incoming);
  if (target.length === 0) return 0;
  return recentBodies.filter((b) => strip(b) === target).length;
}

/**
 * A sender is repeating themselves at machine fidelity once the same body
 * has arrived this many times BEFORE the current one. Two priors (three
 * total) and not one, because a human genuinely double-texts the same "did
 * you get my message?" and deserves an answer the second time.
 */
export const REPEAT_SUPPRESS_THRESHOLD = 2;

/**
 * A single identical prior IS enough when it landed this close: transport
 * duplicates (a carrier or messaging app sending one text twice, distinct
 * Telnyx message AND event ids, so the event-id unique index cannot catch
 * them) arrive sub-second, plus a few seconds of webhook jitter between the
 * two job inserts. A human re-asking after no answer takes longer than this
 * (Amy Laidlaw, 2026-08-19: two copies of a lead's question received 412ms
 * apart, job rows 2.4s apart, and each drew its own differently-worded
 * reply). Measured between job insert times, the one clock both copies
 * share.
 */
export const DUPLICATE_DELIVERY_WINDOW_MS = 10_000;

/** An inbound with the timing/identity needed by the duplicate detector. */
export type TimedInboundText = {
  text: string;
  /** The job row's insert time (`created_at`), epoch ms. */
  atMs: number;
  /**
   * Job row id, the tiebreak when two inserts share a millisecond (the
   * queue's own FIFO orders by `(created_at, id)`, this mirrors it). The
   * webhook checks BEFORE inserting its own row, so its incoming has no id
   * yet and any equal-time stored row counts as earlier.
   */
  id?: string;
};

/**
 * Is `prior` earlier than `incoming` by the queue's `(created_at, id)`
 * order? Exactly one copy of a same-millisecond pair wins, so exactly one
 * gets a reply. A non-finite timestamp (unparseable created_at) compares
 * false and fails open to replying.
 */
function priorIsEarlier(prior: TimedInboundText, incoming: TimedInboundText): boolean {
  if (prior.atMs !== incoming.atMs) return prior.atMs < incoming.atMs;
  if (incoming.id === undefined) return true;
  if (prior.id === undefined) return false;
  return prior.id < incoming.id;
}

/**
 * True when `incoming` is a transport-duplicate of `prior`: same fingerprint,
 * `prior` earlier by `(atMs, id)`, and within `DUPLICATE_DELIVERY_WINDOW_MS`.
 *
 * Unlike `countIdenticalRecent`, URLs are NOT stripped before comparing: two
 * lead notices seconds apart that differ only by their per-lead link are two
 * different leads and both must process. A true duplicate delivery carries
 * byte-identical links anyway.
 */
export function isDuplicateDelivery(prior: TimedInboundText, incoming: TimedInboundText): boolean {
  const target = normalizeSmsFingerprint(incoming.text);
  if (target.length === 0) return false;
  if (normalizeSmsFingerprint(prior.text) !== target) return false;
  if (!priorIsEarlier(prior, incoming)) return false;
  return incoming.atMs - prior.atMs <= DUPLICATE_DELIVERY_WINDOW_MS;
}

export type AutoResponderVerdict = {
  suppress: boolean;
  /** Which detector fired; null when the message looks human. */
  reason:
    | "auto_responder_wording"
    | "repeated_inbound"
    | "duplicate_delivery"
    | "reply_flood"
    | null;
};

/**
 * The whole decision in one place, so the worker branch stays a one-liner
 * and the tests pin the policy rather than the plumbing.
 *
 * Wording alone suppresses on the FIRST sighting: by the time a do-not-reply
 * notice has arrived, replying can only start a loop or text a void. The
 * repeat detector needs `REPEAT_SUPPRESS_THRESHOLD` priors, per above. The
 * duplicate detector needs only one prior but a tight clock: an identical
 * text from the same sender inside `DUPLICATE_DELIVERY_WINDOW_MS` already
 * has its answer in flight from the earlier copy. A slower double-text
 * still gets its answer.
 */
export function autoResponderVerdict(
  recent: readonly TimedInboundText[],
  incoming: TimedInboundText
): AutoResponderVerdict {
  if (looksLikeAutoResponder(incoming.text)) {
    return { suppress: true, reason: "auto_responder_wording" };
  }
  if (countIdenticalRecent(recent.map((r) => r.text), incoming.text) >= REPEAT_SUPPRESS_THRESHOLD) {
    return { suppress: true, reason: "repeated_inbound" };
  }
  if (recent.some((r) => isDuplicateDelivery(r, incoming))) {
    return { suppress: true, reason: "duplicate_delivery" };
  }
  return { suppress: false, reason: null };
}

/**
 * The circuit breaker: how many GENERATED replies to one recipient fit in a
 * rolling hour before the worker stops replying to them entirely.
 *
 * This is the backstop the two detectors above cannot be. Wording detection
 * needs the other bot to say it is a bot; repeat detection needs the other
 * bot to repeat itself. A loop against a bot that varies its text every lap
 * (as OUR side did on 2026-08-07: seventeen laps, every reply a fresh
 * paraphrase) slips both, and the July 2026 incident (103 replies to a
 * Clever bot in one evening) showed where that ends. Rate is the one
 * signature a loop cannot avoid having.
 *
 * The threshold is deliberately far above human conversation: twelve
 * generated replies in sixty minutes means a reply every five minutes,
 * sustained, for an hour. A 30-second bot loop hits it in about six
 * minutes. Proposed as "max 5/hour" in the July incident write-up; raised
 * here because a genuinely chatty human plus today's ack/tapback
 * suppression can still legitimately draw close to that many.
 */
export const REPLY_FLOOD_PER_HOUR = 12;

/** True when this many replies have already gone out in the window. */
export function isReplyFlood(recentReplyCount: number): boolean {
  return recentReplyCount >= REPLY_FLOOD_PER_HOUR;
}
