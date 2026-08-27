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
  // the 0.5 fraction about 7s of possible playout is required.
  const scriptChars = 209;

  it("refuses call 06a44d56's shape: end_call moments after the handover", () => {
    // The whole call lasted 13 seconds from ANSWER; the script was handed
    // over and the model asked to hang up within about a second. One second
    // elapsed plus the 3s goodbye grace cannot hold a 14-second message.
    expect(
      voicemailPlausiblyDelivered({ elapsedMs: 1000, hangupGraceMs: 3000, scriptChars })
    ).toBe(false);
  });

  it("accepts a real-time read: elapsed roughly the full script duration", () => {
    expect(
      voicemailPlausiblyDelivered({ elapsedMs: 14000, hangupGraceMs: 3000, scriptChars })
    ).toBe(true);
  });

  it("accepts a fast, buffered read where generation outpaced playout", () => {
    // Gemini can generate audio faster than realtime; Telnyx keeps playing
    // its buffer through the goodbye grace. 5s of generation plus 3s of
    // grace clears the ~7s bar, so legitimate quick reads are not refused.
    expect(
      voicemailPlausiblyDelivered({ elapsedMs: 5000, hangupGraceMs: 3000, scriptChars })
    ).toBe(true);
  });

  it("sits exactly at the boundary: required time counts as delivered", () => {
    const required = voicemailFullReadMs(scriptChars) * VOICEMAIL_MIN_DELIVERED_FRACTION;
    expect(
      voicemailPlausiblyDelivered({ elapsedMs: required - 3000, hangupGraceMs: 3000, scriptChars })
    ).toBe(true);
    expect(
      voicemailPlausiblyDelivered({
        elapsedMs: required - 3001,
        hangupGraceMs: 3000,
        scriptChars
      })
    ).toBe(false);
  });

  it("always accepts an empty script, which needs no time at all", () => {
    expect(voicemailPlausiblyDelivered({ elapsedMs: 0, hangupGraceMs: 0, scriptChars: 0 })).toBe(
      true
    );
  });
});
