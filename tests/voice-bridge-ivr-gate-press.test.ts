import { describe, it, expect } from "vitest";
import {
  decideIvrPress,
  IVR_REPRESS_COOLDOWN_MS,
  IVR_REFALLBACK_MS,
  IVR_MAX_ACCEPT_PRESSES
} from "../vps/voice-bridge/src/ivr-gate-press";

describe("decideIvrPress", () => {
  const base = {
    ended: false,
    hasDtmf: true,
    inFlight: false,
    acceptPressed: false,
    acceptPressCount: 0,
    attemptCount: 0,
    lastPressAtMs: 0,
    nowMs: 10_000,
    source: "model" as const
  };

  it("caps on ATTEMPTS, so failing presses cannot retry unbounded", () => {
    // The old cap keyed on Telnyx-OK presses only: with a partner endpoint
    // 422ing every send_dtmf, acceptPressCount stayed 0 and the failing path
    // retried without bound. Five attempts, zero successes, still denied.
    expect(
      decideIvrPress({
        ...base,
        attemptCount: IVR_MAX_ACCEPT_PRESSES,
        acceptPressCount: 0,
        source: "model"
      })
    ).toEqual({ action: "deny", reason: "max_presses" });
    // A refallback past the attempt cap is denied too.
    expect(
      decideIvrPress({
        ...base,
        acceptPressed: true,
        attemptCount: IVR_MAX_ACCEPT_PRESSES,
        acceptPressCount: 1,
        source: "refallback"
      })
    ).toEqual({ action: "deny", reason: "max_presses" });
  });

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
        acceptPressCount: 1,
        lastPressAtMs: 10_000 - IVR_REPRESS_COOLDOWN_MS,
        nowMs: 10_000,
        source: "model"
      })
    ).toEqual({ action: "press", repress: true });
  });

  it("allows a refallback even inside the model cooldown window", () => {
    expect(
      decideIvrPress({
        ...base,
        acceptPressed: true,
        acceptPressCount: 1,
        lastPressAtMs: 10_000 - 100,
        nowMs: 10_000,
        source: "refallback"
      })
    ).toEqual({ action: "press", repress: true });
  });

  it("allows a spaced refallback after the first OK", () => {
    expect(
      decideIvrPress({
        ...base,
        acceptPressed: true,
        acceptPressCount: 1,
        lastPressAtMs: 0,
        nowMs: IVR_REFALLBACK_MS,
        source: "refallback"
      })
    ).toEqual({ action: "press", repress: true });
  });

  it("suppresses model re-presses inside the cooldown window", () => {
    expect(
      decideIvrPress({
        ...base,
        acceptPressed: true,
        acceptPressCount: 1,
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
        acceptPressCount: 1,
        lastPressAtMs: 0,
        nowMs: 60_000,
        source: "fallback"
      })
    ).toEqual({ action: "deny", reason: "fallback_already_pressed" });
  });

  it("locks out every press once the per-call cap is reached", () => {
    // Five OK presses imply five attempts; the cap keys on attempts.
    expect(
      decideIvrPress({
        ...base,
        acceptPressed: true,
        acceptPressCount: IVR_MAX_ACCEPT_PRESSES,
        attemptCount: IVR_MAX_ACCEPT_PRESSES,
        lastPressAtMs: 0,
        nowMs: 60_000,
        source: "model"
      })
    ).toEqual({ action: "deny", reason: "max_presses" });
    expect(
      decideIvrPress({
        ...base,
        acceptPressCount: IVR_MAX_ACCEPT_PRESSES,
        attemptCount: IVR_MAX_ACCEPT_PRESSES,
        source: "fallback"
      })
    ).toEqual({ action: "deny", reason: "max_presses" });
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
