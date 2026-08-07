import { describe, expect, it } from "vitest";
import {
  autoResponderVerdict,
  countIdenticalRecent,
  isReplyFlood,
  looksLikeAutoResponder,
  normalizeSmsFingerprint,
  REPEAT_SUPPRESS_THRESHOLD,
  REPLY_FLOOD_PER_HOUR
} from "../supabase/functions/_shared/sms_auto_responder";

/**
 * The bot-vs-bot loop guard (sms_auto_responder.ts). The fixtures are the
 * REAL texts from the 2026-08-07 incident on Amy Laidlaw's account: the
 * coworker and HomeLight's auto-responder replied to each other every ~30s,
 * seventeen laps, an urgent owner alert per lap. Every "must suppress" case
 * here is a message that actually drew a reply that day.
 */

const HOMELIGHT_NOT_MONITORED =
  "Thank you for contacting HomeLight. This phone number is not monitored. Please email support@homelight.com with any questions.";
const HOMELIGHT_FEEDBACK =
  "Great job connecting with Eugene! Provide feedback for your experience with your HomeLight referral using the link below.  https://hmlt.co/6xyz";

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

describe("autoResponderVerdict", () => {
  it("suppresses on wording alone, first sighting, no history needed", () => {
    expect(autoResponderVerdict([], HOMELIGHT_NOT_MONITORED)).toEqual({
      suppress: true,
      reason: "auto_responder_wording"
    });
  });

  it("suppresses a machine-fidelity repeat at the threshold", () => {
    const priors = Array.from({ length: REPEAT_SUPPRESS_THRESHOLD }, () => HOMELIGHT_FEEDBACK);
    expect(autoResponderVerdict(priors, HOMELIGHT_FEEDBACK)).toEqual({
      suppress: true,
      reason: "repeated_inbound"
    });
  });

  it("still answers a human double-text (below the threshold)", () => {
    expect(autoResponderVerdict(["did you get my message?"], "Did you get my message?")).toEqual({
      suppress: false,
      reason: null
    });
  });

  it("lets a normal first message through", () => {
    expect(autoResponderVerdict([], "Hi, I'd like to sell my house")).toEqual({
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
