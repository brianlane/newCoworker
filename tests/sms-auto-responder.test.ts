import { describe, expect, it } from "vitest";
import {
  autoResponderVerdict,
  countIdenticalRecent,
  DUPLICATE_DELIVERY_WINDOW_MS,
  isDuplicateDelivery,
  isReplyFlood,
  looksLikeAutoResponder,
  normalizeSmsFingerprint,
  REPEAT_SUPPRESS_THRESHOLD,
  REPLY_FLOOD_PER_HOUR,
  type TimedInboundText
} from "../supabase/functions/_shared/sms_auto_responder";

/**
 * The bot-vs-bot loop guard (sms_auto_responder.ts). The fixtures are the
 * REAL texts from two incidents on Amy Laidlaw's account: 2026-08-07, when
 * the coworker and HomeLight's auto-responder replied to each other every
 * ~30s (seventeen laps, an urgent owner alert per lap), and 2026-08-19,
 * when a lead's question was delivered twice 412ms apart and each copy drew
 * its own differently-worded reply. Every "must suppress" case here is a
 * message that actually drew a reply on one of those days.
 */

const HOMELIGHT_NOT_MONITORED =
  "Thank you for contacting HomeLight. This phone number is not monitored. Please email support@homelight.com with any questions.";
const HOMELIGHT_FEEDBACK =
  "Great job connecting with Eugene! Provide feedback for your experience with your HomeLight referral using the link below.  https://hmlt.co/6xyz";
const JULIA_DUPLICATE =
  "Hi Amy! I am interested in getting further information! But prefer text for now. Do you just charge the 1.5%? ";

/** Shorthand for the timed shape the verdict and duplicate detector take. */
const msg = (text: string, atMs: number, id?: string): TimedInboundText => ({ text, atMs, id });

describe("normalizeSmsFingerprint", () => {
  it("collapses whitespace and case", () => {
    expect(normalizeSmsFingerprint("  Hello   THERE\n\nfriend ")).toBe("hello there friend");
  });

  it("flattens smart quotes so re-encoded sends fingerprint identically", () => {
    expect(normalizeSmsFingerprint("don’t reply")).toBe("don't reply");
    expect(normalizeSmsFingerprint("“quoted”")).toBe("'quoted'");
  });
});

describe("looksLikeAutoResponder", () => {
  it("catches the exact HomeLight notice from the incident", () => {
    expect(looksLikeAutoResponder(HOMELIGHT_NOT_MONITORED)).toBe(true);
  });

  it("catches the common wording family", () => {
    for (const text of [
      "This number is not monitored.",
      "This inbox is unmonitored",
      "this line is not monitored",
      "That is not a monitored number",
      "Please do not reply to this message",
      "Do not respond to this text",
      "This is an automated message",
      "This is an automated notification from your pharmacy",
      "Automated reply. Please do not reply.",
      "You are receiving this automated alert because you opted in",
      "You're receiving this automated alert",
      "This number cannot receive replies",
      "This number can't accept messages",
      "Replies to this number are not monitored",
      "replies are not read"
    ]) {
      expect(looksLikeAutoResponder(text), text).toBe(true);
    }
  });

  it("lets human messages through, including ones about monitoring", () => {
    for (const text of [
      HOMELIGHT_FEEDBACK,
      "Yes, noon works for me",
      "Can you monitor the listing activity for me?",
      "I set up a baby monitor in the nursery",
      "ok",
      "I'll reply to this later tonight",
      "my number changed, text me at 480-555-1212"
    ]) {
      expect(looksLikeAutoResponder(text), text).toBe(false);
    }
  });

  it("is false for empty and whitespace-only text", () => {
    expect(looksLikeAutoResponder("")).toBe(false);
    expect(looksLikeAutoResponder("   \n ")).toBe(false);
  });
});

describe("countIdenticalRecent", () => {
  it("counts normalized-identical bodies", () => {
    const recent = [HOMELIGHT_NOT_MONITORED, HOMELIGHT_NOT_MONITORED.toUpperCase(), "hi there"];
    expect(countIdenticalRecent(recent, HOMELIGHT_NOT_MONITORED)).toBe(2);
  });

  it("ignores trailing tracking links when comparing", () => {
    const a = "Rate your visit! https://t.co/abc123";
    const b = "Rate your visit! https://t.co/zzz999";
    expect(countIdenticalRecent([a], b)).toBe(1);
  });

  it("does not match different messages or empty targets", () => {
    expect(countIdenticalRecent(["hello"], "goodbye")).toBe(0);
    expect(countIdenticalRecent(["hello"], "")).toBe(0);
    // A link-only message strips to empty and must never match everything.
    expect(countIdenticalRecent(["https://a.example"], "https://b.example")).toBe(0);
  });
});

describe("isDuplicateDelivery", () => {
  const WINDOW = DUPLICATE_DELIVERY_WINDOW_MS;

  it("catches the 2026-08-19 duplicate: identical text, 2.4s between inserts", () => {
    const prior = msg(JULIA_DUPLICATE, 15_098, "a7ef772d");
    const incoming = msg(JULIA_DUPLICATE, 17_503, "61caa925");
    expect(isDuplicateDelivery(prior, incoming)).toBe(true);
  });

  it("is bounded by the window: at it yes, past it no", () => {
    expect(isDuplicateDelivery(msg("hey", 0, "a"), msg("hey", WINDOW, "b"))).toBe(true);
    expect(isDuplicateDelivery(msg("hey", 0, "a"), msg("hey", WINDOW + 1, "b"))).toBe(false);
  });

  it("normalizes case and whitespace like the repeat detector", () => {
    expect(isDuplicateDelivery(msg("Hey  There", 0, "a"), msg("hey there ", 500, "b"))).toBe(true);
  });

  it("keeps URLs when comparing: two leads differing only by link both process", () => {
    const leadA = msg("New referral! View: https://x.example/lead/123", 0, "a");
    const leadB = msg("New referral! View: https://x.example/lead/456", 3_000, "b");
    expect(isDuplicateDelivery(leadA, leadB)).toBe(false);
  });

  it("never matches different texts or empty bodies", () => {
    expect(isDuplicateDelivery(msg("hello", 0, "a"), msg("goodbye", 100, "b"))).toBe(false);
    expect(isDuplicateDelivery(msg("", 0, "a"), msg("", 100, "b"))).toBe(false);
  });

  it("only an EARLIER prior suppresses, so exactly one copy replies", () => {
    // The later-inserted copy sees the earlier one and suppresses; the
    // earlier copy sees the later one and does not.
    expect(isDuplicateDelivery(msg("hey", 5_000, "a"), msg("hey", 1_000, "b"))).toBe(false);
  });

  it("breaks a same-millisecond tie by id, mirroring the queue's FIFO order", () => {
    expect(isDuplicateDelivery(msg("hey", 1_000, "aaa"), msg("hey", 1_000, "bbb"))).toBe(true);
    expect(isDuplicateDelivery(msg("hey", 1_000, "bbb"), msg("hey", 1_000, "aaa"))).toBe(false);
  });

  it("an id-less incoming (webhook, row not yet inserted) treats any equal-time row as earlier", () => {
    expect(isDuplicateDelivery(msg("hey", 1_000, "aaa"), msg("hey", 1_000))).toBe(true);
  });

  it("fails open when the equal-time prior has no id to order by", () => {
    expect(isDuplicateDelivery(msg("hey", 1_000), msg("hey", 1_000, "bbb"))).toBe(false);
  });

  it("fails open on an unparseable timestamp", () => {
    expect(isDuplicateDelivery(msg("hey", Number.NaN, "a"), msg("hey", 1_000, "b"))).toBe(false);
  });
});

describe("autoResponderVerdict", () => {
  it("suppresses on wording alone, first sighting, no history needed", () => {
    expect(autoResponderVerdict([], msg(HOMELIGHT_NOT_MONITORED, 0))).toEqual({
      suppress: true,
      reason: "auto_responder_wording"
    });
  });

  it("suppresses a machine-fidelity repeat at the threshold, however slow", () => {
    // Timestamps outside the duplicate window on purpose: the repeat rule
    // is windowless within the fetched history, only the count matters.
    const priors = Array.from({ length: REPEAT_SUPPRESS_THRESHOLD }, (_, i) =>
      msg(HOMELIGHT_FEEDBACK, i * 20 * 60_000, `id-${i}`)
    );
    expect(autoResponderVerdict(priors, msg(HOMELIGHT_FEEDBACK, 60 * 60_000, "id-now"))).toEqual({
      suppress: true,
      reason: "repeated_inbound"
    });
  });

  it("suppresses the second copy of a duplicate delivery inside the window", () => {
    const prior = [msg(JULIA_DUPLICATE, 15_098, "a7ef772d")];
    expect(autoResponderVerdict(prior, msg(JULIA_DUPLICATE, 17_503, "61caa925"))).toEqual({
      suppress: true,
      reason: "duplicate_delivery"
    });
  });

  it("reports the repeat reason when a burst also crosses the threshold", () => {
    const priors = [msg("ping", 1_000, "a"), msg("ping", 2_000, "b")];
    expect(autoResponderVerdict(priors, msg("ping", 3_000, "c"))).toEqual({
      suppress: true,
      reason: "repeated_inbound"
    });
  });

  it("still answers a human double-text slower than the window", () => {
    const prior = [msg("did you get my message?", 0, "a")];
    const again = msg("Did you get my message?", DUPLICATE_DELIVERY_WINDOW_MS + 30_000, "b");
    expect(autoResponderVerdict(prior, again)).toEqual({
      suppress: false,
      reason: null
    });
  });

  it("lets a normal first message through", () => {
    expect(autoResponderVerdict([], msg("Hi, I'd like to sell my house", 0, "a"))).toEqual({
      suppress: false,
      reason: null
    });
  });
});

describe("isReplyFlood", () => {
  /**
   * The circuit breaker is the backstop for a loop where the OTHER bot
   * varies its wording every lap, which slips both content detectors. Rate
   * is the one signature a loop cannot avoid having: the July 2026 incident
   * sent 103 replies to a Clever bot in one evening.
   */
  it("trips at the threshold and not below it", () => {
    expect(isReplyFlood(REPLY_FLOOD_PER_HOUR)).toBe(true);
    expect(isReplyFlood(REPLY_FLOOD_PER_HOUR + 5)).toBe(true);
    expect(isReplyFlood(REPLY_FLOOD_PER_HOUR - 1)).toBe(false);
    expect(isReplyFlood(0)).toBe(false);
  });

  it("stays clear of a busy but human conversation", () => {
    // A reply every 10 minutes for an hour is a chatty human, not a loop.
    expect(isReplyFlood(6)).toBe(false);
  });
});
