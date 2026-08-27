import { describe, expect, it } from "vitest";
import {
  VOICEMAIL_MIN_DELIVERED_FRACTION,
  VOICEMAIL_READ_CHARS_PER_SECOND,
  voicemailFullReadMs,
  voicemailPlausiblyDelivered
} from "../vps/voice-bridge/src/voicemail-timing.ts";

/**
 * Pins the plausibility rule that decides whether `voicemail_spoken` (and so
 * `voicemail_left`) may be stamped at `end_call`. The failing shapes are real
 * calls from Amy Laidlaw's account, 2026-08-26/27, where the stamp landed for
 * messages that physically cannot have played; the passing shapes are the
 * legitimate reads (Tami Nelson-style) the rule must not refuse.
 */
describe("voicemailFullReadMs", () => {
  it("estimates ~14 seconds for Amy's ~210-character scripts", () => {
    expect(voicemailFullReadMs(210)).toBeCloseTo(14000, 5);
    expect(VOICEMAIL_READ_CHARS_PER_SECOND).toBe(15);
  });

  it("treats a negative or zero length as zero rather than negative time", () => {
    expect(voicemailFullReadMs(0)).toBe(0);
    expect(voicemailFullReadMs(-5)).toBe(0);
  });
});

describe("voicemailPlausiblyDelivered", () => {
  // Amy's real round-2 script is 209 characters: full read ~13.9s, so with
  // the 0.5 fraction about 7s of playable line time is required. The caller
  // computes `playableMs` as (first end_call + goodbye grace) minus the
  // script handover moment.
  const scriptChars = 209;

  it("refuses call 06a44d56's shape: end_call moments after the handover", () => {
    // The whole call lasted 13 seconds from ANSWER; the script was handed
    // over and the model asked to hang up within about a second. One second
    // plus the 3s goodbye grace cannot hold a 14-second message.
    expect(voicemailPlausiblyDelivered({ playableMs: 1000 + 3000, scriptChars })).toBe(false);
  });

  it("refuses Bugbot's interleaving: the script handed over mid-grace", () => {
    // Same-turn voicemail_reached + end_call: the hangup timer was already
    // running when the script came back 1s later, so only the REMAINING 2s
    // of grace could carry audio, however late a duplicate end_call lands.
    expect(voicemailPlausiblyDelivered({ playableMs: 3000 - 1000, scriptChars })).toBe(false);
  });

  it("refuses a script handed over after the hangup already fired", () => {
    expect(voicemailPlausiblyDelivered({ playableMs: -900, scriptChars })).toBe(false);
  });

  it("accepts a real-time read: the line was up for the full duration", () => {
    expect(voicemailPlausiblyDelivered({ playableMs: 14000 + 3000, scriptChars })).toBe(true);
  });

  it("accepts a fast, buffered read where generation outpaced playout", () => {
    // Gemini can generate audio faster than realtime; Telnyx keeps playing
    // its buffer through the goodbye grace. 5s of generation plus 3s of
    // grace clears the ~7s bar, so legitimate quick reads are not refused.
    expect(voicemailPlausiblyDelivered({ playableMs: 5000 + 3000, scriptChars })).toBe(true);
  });

  it("sits exactly at the boundary: required time counts as delivered", () => {
    const required = voicemailFullReadMs(scriptChars) * VOICEMAIL_MIN_DELIVERED_FRACTION;
    expect(voicemailPlausiblyDelivered({ playableMs: required, scriptChars })).toBe(true);
    expect(voicemailPlausiblyDelivered({ playableMs: required - 1, scriptChars })).toBe(false);
  });

  it("always accepts an empty script, which needs no time at all", () => {
    expect(voicemailPlausiblyDelivered({ playableMs: 0, scriptChars: 0 })).toBe(true);
  });
});
