import { describe, expect, it } from "vitest";
import {
  EDGE_VOICEMAIL_MIN_DELIVERED_FRACTION,
  EDGE_VOICEMAIL_READ_CHARS_PER_SECOND,
  edgeVoicemailFullReadMs,
  edgeVoicemailPlausiblyDelivered,
  resolveEdgeVoicemailSpoken
} from "../supabase/functions/_shared/voice_voicemail_timing.ts";
import {
  VOICEMAIL_MIN_DELIVERED_FRACTION,
  VOICEMAIL_READ_CHARS_PER_SECOND
} from "../vps/voice-bridge/src/voicemail-timing.ts";

/**
 * The Edge-spoken voicemail's honesty rule. The Edge stamps
 * `voicemail_speak_started_at` when Telnyx ACCEPTS the speak command; whether
 * the message actually played is judged by `call.speak.ended` or, because
 * Telnyx drops whole webhook classes (2026-08-25 collapse), by this
 * wall-clock fallback at hangup.
 */
describe("edge voicemail timing", () => {
  it("mirrors the bridge-side constants exactly (PR #1672)", () => {
    // Two modules, one judgement. The bridge (model-spoken path) and the
    // Edge (Telnyx-spoken path) must agree on what "delivered" means, or the
    // same call could read voicemail_left differently depending on who spoke.
    expect(EDGE_VOICEMAIL_READ_CHARS_PER_SECOND).toBe(VOICEMAIL_READ_CHARS_PER_SECOND);
    expect(EDGE_VOICEMAIL_MIN_DELIVERED_FRACTION).toBe(VOICEMAIL_MIN_DELIVERED_FRACTION);
  });

  it("estimates a full read at 15 chars per second", () => {
    expect(edgeVoicemailFullReadMs(150)).toBe(10_000);
    expect(edgeVoicemailFullReadMs(0)).toBe(0);
    // Negative lengths cannot produce a negative requirement.
    expect(edgeVoicemailFullReadMs(-30)).toBe(0);
  });

  it("accepts a window of at least half the read time", () => {
    // 150 chars = 10s full read; half = 5s.
    const startedAtIso = "2026-08-27T15:35:30.000Z";
    expect(
      edgeVoicemailPlausiblyDelivered({
        startedAtIso,
        endedAtIso: "2026-08-27T15:35:35.000Z",
        scriptChars: 150
      })
    ).toBe(true);
    expect(
      edgeVoicemailPlausiblyDelivered({
        startedAtIso,
        endedAtIso: "2026-08-27T15:35:34.999Z",
        scriptChars: 150
      })
    ).toBe(false);
  });

  it("fails the check when either timestamp is missing or unparseable", () => {
    // An unprovable delivery is reported as none: understating once beats
    // telling the owner a message was left when it cannot be shown.
    expect(
      edgeVoicemailPlausiblyDelivered({
        startedAtIso: undefined,
        endedAtIso: "2026-08-27T15:35:35.000Z",
        scriptChars: 10
      })
    ).toBe(false);
    expect(
      edgeVoicemailPlausiblyDelivered({
        startedAtIso: "not a date",
        endedAtIso: "2026-08-27T15:35:35.000Z",
        scriptChars: 10
      })
    ).toBe(false);
    expect(
      edgeVoicemailPlausiblyDelivered({
        startedAtIso: "2026-08-27T15:35:30.000Z",
        endedAtIso: null,
        scriptChars: 10
      })
    ).toBe(false);
  });
});

describe("resolveEdgeVoicemailSpoken", () => {
  const startedAtIso = "2026-08-27T15:35:30.000Z";

  it("trusts the direct stamp without any window math", () => {
    expect(
      resolveEdgeVoicemailSpoken({
        voicemailSpoken: true,
        startedAtIso: undefined,
        storedScriptChars: undefined,
        fallbackScript: undefined,
        endedAtIso: undefined
      })
    ).toBe(true);
  });

  it("answers false when no Edge speak was ever issued", () => {
    // No started_at means /actions/speak never accepted a command for this
    // leg; only the direct stamp (bridge confirmSpoken, speak.ended) counts.
    expect(
      resolveEdgeVoicemailSpoken({
        voicemailSpoken: false,
        startedAtIso: undefined,
        storedScriptChars: 150,
        fallbackScript: "x".repeat(150),
        endedAtIso: "2026-08-27T15:36:30.000Z"
      })
    ).toBe(false);
  });

  it("judges by the stored script length when present", () => {
    // 150 chars needs 5s; the leg stayed up 6s.
    expect(
      resolveEdgeVoicemailSpoken({
        voicemailSpoken: undefined,
        startedAtIso,
        storedScriptChars: 150,
        fallbackScript: undefined,
        endedAtIso: "2026-08-27T15:35:36.000Z"
      })
    ).toBe(true);
    // Same window, a script four times as long: not plausible.
    expect(
      resolveEdgeVoicemailSpoken({
        voicemailSpoken: undefined,
        startedAtIso,
        storedScriptChars: 600,
        fallbackScript: undefined,
        endedAtIso: "2026-08-27T15:35:36.000Z"
      })
    ).toBe(false);
  });

  it("falls back to the configured script when the stored length is unusable", () => {
    expect(
      resolveEdgeVoicemailSpoken({
        voicemailSpoken: undefined,
        startedAtIso,
        storedScriptChars: Number.NaN,
        fallbackScript: ` ${"x".repeat(150)} `,
        endedAtIso: "2026-08-27T15:35:36.000Z"
      })
    ).toBe(true);
    expect(
      resolveEdgeVoicemailSpoken({
        voicemailSpoken: undefined,
        startedAtIso,
        storedScriptChars: 0,
        fallbackScript: "x".repeat(600),
        endedAtIso: "2026-08-27T15:35:36.000Z"
      })
    ).toBe(false);
  });

  it("refuses to vouch for a speak with no measurable script", () => {
    // started_at with nothing to measure is corrupt context; do not lie.
    expect(
      resolveEdgeVoicemailSpoken({
        voicemailSpoken: undefined,
        startedAtIso,
        storedScriptChars: undefined,
        fallbackScript: "   ",
        endedAtIso: "2026-08-27T15:36:30.000Z"
      })
    ).toBe(false);
    expect(
      resolveEdgeVoicemailSpoken({
        voicemailSpoken: undefined,
        startedAtIso,
        storedScriptChars: undefined,
        fallbackScript: 42,
        endedAtIso: "2026-08-27T15:36:30.000Z"
      })
    ).toBe(false);
  });
});
