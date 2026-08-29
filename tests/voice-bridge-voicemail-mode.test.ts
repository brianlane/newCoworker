import { describe, expect, it } from "vitest";
import {
  AMD_RESOLUTION_SETTINGS_KEY,
  deterministicVoicemailArmed,
  NUMBER_GUARD_SETTINGS_KEY,
  parseRolloutGate,
  rolloutIncludes,
  VOICEMAIL_DETERMINISTIC_END_CALL_REPLY,
  VOICEMAIL_DETERMINISTIC_TOOL_REPLY,
  VOICEMAIL_END_CALL_HOLD_MS,
  VOICEMAIL_MUTE_LIFTED_CUE,
  VOICEMAIL_RESOLUTION_POLL_MS
} from "../vps/voice-bridge/src/voicemail-mode";
import {
  AMD_RESOLUTION_SETTINGS_KEY as EDGE_AMD_KEY,
  parseAmdResolutionConfig
} from "../supabase/functions/_shared/voice_amd_resolution.ts";

/**
 * Deterministic voicemail delivery: the model's mouth is removed from the
 * delivery path on outbound machine legs with an authored script, and the
 * edge (greeting handler or AMD resolution sweep) speaks the script over
 * Telnyx TTS. The gate parsing here is a lockstep copy of the edge's
 * parseAmdResolutionConfig, because the bridge muting a leg the sweep will
 * never resolve would be a silent, refused-to-die call.
 */
describe("parseRolloutGate (lockstep with edge parseAmdResolutionConfig)", () => {
  const FIXTURES: unknown[] = [
    null,
    undefined,
    "enabled",
    42,
    {},
    { enabled: false, business_ids: ["a"] },
    { enabled: "true", business_ids: ["a"] },
    { enabled: true },
    { enabled: true, business_ids: [] },
    { enabled: true, business_ids: ["621a5b0d", "", "  ", 7, "kyp"] },
    { enabled: true, all_businesses: true },
    { enabled: true, all_businesses: "yes", business_ids: ["a"] },
    { enabled: true, all_businesses: true, business_ids: ["a"] }
  ];

  it("agrees with the edge parser on every fixture", () => {
    for (const raw of FIXTURES) {
      const bridge = parseRolloutGate(raw);
      const edge = parseAmdResolutionConfig(raw);
      expect(bridge.enabled, `enabled mismatch on ${JSON.stringify(raw)}`).toBe(edge.enabled);
      expect(bridge.allBusinesses, `allBusinesses mismatch on ${JSON.stringify(raw)}`).toBe(
        edge.allBusinesses
      );
      expect([...bridge.businessIds].sort(), `ids mismatch on ${JSON.stringify(raw)}`).toEqual(
        [...edge.businessIds].sort()
      );
    }
  });

  it("the settings key is the edge's key, character for character", () => {
    expect(AMD_RESOLUTION_SETTINGS_KEY).toBe(EDGE_AMD_KEY);
  });

  it("the guard gate has its own distinct key", () => {
    expect(NUMBER_GUARD_SETTINGS_KEY).toBe("voice_spoken_number_guard");
    expect(NUMBER_GUARD_SETTINGS_KEY).not.toBe(AMD_RESOLUTION_SETTINGS_KEY);
  });
});

describe("rolloutIncludes", () => {
  it("enrolls by id, by all_businesses, and never when disabled", () => {
    expect(
      rolloutIncludes(parseRolloutGate({ enabled: true, business_ids: ["amy"] }), "amy")
    ).toBe(true);
    expect(
      rolloutIncludes(parseRolloutGate({ enabled: true, business_ids: ["amy"] }), "kyp")
    ).toBe(false);
    expect(rolloutIncludes(parseRolloutGate({ enabled: true, all_businesses: true }), "kyp")).toBe(
      true
    );
    expect(
      rolloutIncludes(parseRolloutGate({ enabled: false, all_businesses: true }), "amy")
    ).toBe(false);
    expect(rolloutIncludes(parseRolloutGate(null), "amy")).toBe(false);
  });
});

describe("deterministicVoicemailArmed", () => {
  const base = {
    direction: "outbound" as const,
    voicemailScript: "Call us back at 602-695-1142.",
    amdResolutionEnrolled: true
  };

  it("arms only for outbound + authored script + enrollment", () => {
    expect(deterministicVoicemailArmed(base)).toBe(true);
  });

  it("never arms inbound: the sweep would hang up a live-transfer leg as scriptless", () => {
    expect(deterministicVoicemailArmed({ ...base, direction: "inbound" })).toBe(false);
  });

  it("never arms without a script: the scriptless outcome needs no mute", () => {
    expect(deterministicVoicemailArmed({ ...base, voicemailScript: "" })).toBe(false);
    expect(deterministicVoicemailArmed({ ...base, voicemailScript: "   " })).toBe(false);
  });

  it("never arms without the sweep backstop: nothing would speak or end the leg", () => {
    expect(deterministicVoicemailArmed({ ...base, amdResolutionEnrolled: false })).toBe(false);
  });
});

describe("deterministic-mode constants", () => {
  it("both replies tell the model to stay silent and not end the call", () => {
    for (const reply of [
      VOICEMAIL_DETERMINISTIC_TOOL_REPLY,
      VOICEMAIL_DETERMINISTIC_END_CALL_REPLY
    ]) {
      expect(reply).toMatch(/end_call/);
      expect(reply).toMatch(/automatically/);
    }
  });

  it("the end_call hold outlives the sweep's grace but never a mailbox recording limit", () => {
    // The sweep acts 25s after the stamp on a 15s cadence, then the script
    // needs playout; a mailbox bounds the leg at 60-180s regardless.
    expect(VOICEMAIL_END_CALL_HOLD_MS).toBeGreaterThanOrEqual(60_000);
    expect(VOICEMAIL_END_CALL_HOLD_MS).toBeLessThanOrEqual(180_000);
  });

  it("the resolution poll runs several times inside the hold window", () => {
    // The poll is the lift for a withdrawn verdict (Apple screening clears
    // the machine stamp and the sweep then never speaks); a poll slower than
    // the hold would make the lift decorative.
    expect(VOICEMAIL_RESOLUTION_POLL_MS).toBeGreaterThanOrEqual(1_000);
    expect(VOICEMAIL_RESOLUTION_POLL_MS * 5).toBeLessThanOrEqual(VOICEMAIL_END_CALL_HOLD_MS);
  });

  it("the mute-lift cue explicitly overrides the earlier stay-silent instruction", () => {
    expect(VOICEMAIL_MUTE_LIFTED_CUE.startsWith("[Coordinator]")).toBe(true);
    expect(VOICEMAIL_MUTE_LIFTED_CUE).toMatch(/Disregard/i);
    expect(VOICEMAIL_MUTE_LIFTED_CUE).toMatch(/end_call/);
  });
});
