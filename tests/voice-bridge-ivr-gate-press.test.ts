import { describe, it, expect } from "vitest";
import {
  decideIvrPress,
  IVR_REPRESS_COOLDOWN_MS,
  IVR_REFALLBACK_MS
} from "../vps/voice-bridge/src/ivr-gate-press";

describe("decideIvrPress", () => {
  const base = {
    ended: false,
    hasDtmf: true,
    inFlight: false,
    acceptPressed: false,
    humanHeard: false,
    lastPressAtMs: 0,
    nowMs: 10_000,
    source: "model" as const
  };

  it("allows the first press from model or fallback", () => {
    expect(decideIvrPress({ ...base, source: "model" })).toEqual({
      action: "press",
      repress: false
    });
    expect(decideIvrPress({ ...base, source: "fallback" })).toEqual({
      action: "press",
      repress: false
    });
  });

  it("allows a model re-press after a prior OK once the cooldown has elapsed", () => {
    expect(
      decideIvrPress({
        ...base,
        acceptPressed: true,
        lastPressAtMs: 10_000 - IVR_REPRESS_COOLDOWN_MS,
        nowMs: 10_000,
        source: "model"
      })
    ).toEqual({ action: "press", repress: true });
  });

  it("allows a refallback re-press after the cooldown", () => {
    expect(
      decideIvrPress({
        ...base,
        acceptPressed: true,
        lastPressAtMs: 0,
        nowMs: IVR_REFALLBACK_MS,
        source: "refallback"
      })
    ).toEqual({ action: "press", repress: true });
  });

  it("suppresses re-presses inside the cooldown window", () => {
    expect(
      decideIvrPress({
        ...base,
        acceptPressed: true,
        lastPressAtMs: 10_000 - (IVR_REPRESS_COOLDOWN_MS - 1),
        nowMs: 10_000,
        source: "model"
      })
    ).toEqual({ action: "deny", reason: "cooldown" });
  });

  it("never lets the first fallback fire again after a successful press", () => {
    expect(
      decideIvrPress({
        ...base,
        acceptPressed: true,
        lastPressAtMs: 0,
        nowMs: 60_000,
        source: "fallback"
      })
    ).toEqual({ action: "deny", reason: "fallback_already_pressed" });
  });

  it("locks out every press once a human has been heard (assistant spoke)", () => {
    expect(
      decideIvrPress({
        ...base,
        acceptPressed: true,
        humanHeard: true,
        lastPressAtMs: 0,
        nowMs: 60_000,
        source: "model"
      })
    ).toEqual({ action: "deny", reason: "human_heard" });
    expect(
      decideIvrPress({
        ...base,
        humanHeard: true,
        source: "fallback"
      })
    ).toEqual({ action: "deny", reason: "human_heard" });
  });

  it("denies while a press is in flight, ended, or DTMF is missing", () => {
    expect(decideIvrPress({ ...base, inFlight: true })).toEqual({
      action: "deny",
      reason: "in_flight"
    });
    expect(decideIvrPress({ ...base, ended: true })).toEqual({
      action: "deny",
      reason: "ended"
    });
    expect(decideIvrPress({ ...base, hasDtmf: false })).toEqual({
      action: "deny",
      reason: "no_dtmf"
    });
  });
});
