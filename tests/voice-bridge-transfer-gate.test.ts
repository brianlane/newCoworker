import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideTransferStart,
  TRANSFER_MAX_ATTEMPTS_PER_CALL,
  TRANSFER_REFUSED_DETAIL,
  TRANSFER_RETRY_COOLDOWN_MS
} from "../vps/voice-bridge/src/transfer-gate";

/**
 * One transfer/ladder per live call. Concurrent ladders on 2026-09-06 hung
 * up Amy Laidlaw's ringing phone within a second of each dial because each
 * transfer_to_owner started a fresh reach ladder on the same A leg.
 */

const BRIDGE = join(__dirname, "../vps/voice-bridge/src/gemini-telnyx-bridge.ts");

describe("decideTransferStart", () => {
  const idle = {
    inFlight: false,
    attemptCount: 0,
    lastExhaustedAtMs: null as number | null,
    nowMs: 10_000
  };

  it("starts the first transfer on a call", () => {
    expect(decideTransferStart(idle)).toEqual({ action: "start" });
  });

  it("refuses while a ladder is already in flight", () => {
    expect(decideTransferStart({ ...idle, inFlight: true })).toEqual({
      action: "deny",
      reason: "in_flight",
      detail: TRANSFER_REFUSED_DETAIL.in_flight
    });
  });

  it("refuses a retry inside the exhausted cooldown", () => {
    expect(
      decideTransferStart({
        ...idle,
        attemptCount: 1,
        lastExhaustedAtMs: 10_000 - 1_000,
        nowMs: 10_000
      })
    ).toEqual({
      action: "deny",
      reason: "cooldown",
      detail: TRANSFER_REFUSED_DETAIL.cooldown
    });
  });

  it("allows a second start after the cooldown, then caps at two", () => {
    expect(
      decideTransferStart({
        ...idle,
        attemptCount: 1,
        lastExhaustedAtMs: 10_000 - TRANSFER_RETRY_COOLDOWN_MS,
        nowMs: 10_000
      })
    ).toEqual({ action: "start" });
    expect(
      decideTransferStart({
        ...idle,
        attemptCount: TRANSFER_MAX_ATTEMPTS_PER_CALL,
        lastExhaustedAtMs: 10_000 - TRANSFER_RETRY_COOLDOWN_MS * 2,
        nowMs: 10_000
      })
    ).toEqual({
      action: "deny",
      reason: "max_attempts",
      detail: TRANSFER_REFUSED_DETAIL.max_attempts
    });
  });

  it("in_flight wins over cooldown and the cap, so a running ladder is unique", () => {
    expect(
      decideTransferStart({
        inFlight: true,
        attemptCount: TRANSFER_MAX_ATTEMPTS_PER_CALL,
        lastExhaustedAtMs: 9_000,
        nowMs: 10_000
      })
    ).toEqual({
      action: "deny",
      reason: "in_flight",
      detail: TRANSFER_REFUSED_DETAIL.in_flight
    });
  });

  it("carries no em dash (repo writing rule)", () => {
    for (const detail of Object.values(TRANSFER_REFUSED_DETAIL)) {
      expect(detail).not.toContain("\u2014");
    }
  });
});

describe("the bridge latches in_flight before the async transfer dispatch", () => {
  const src = readFileSync(BRIDGE, "utf8");
  const handler = src.slice(src.indexOf('if (name === "transfer_to_owner" && opts.transfer)'));
  const asyncIife = handler.indexOf("void (async () => {");

  it("decides and sets in_flight in the synchronous loop, before void async", () => {
    // Two transfer_to_owner calls in one Live toolCall batch would both pass
    // an async-only gate: the first handler returns immediately. The latch
    // has to flip before the IIFE, the same shape as batchRequestsEndCall.
    expect(asyncIife).toBeGreaterThan(-1);
    const before = handler.slice(0, asyncIife);
    expect(before).toContain("decideTransferStart");
    expect(before).toContain("transferInFlight = true");
    expect(before).toContain("transferAttemptCount += 1");
    expect(before).toContain("voice_bridge_transfer_refused");
  });

  it("passes the session AbortSignal into execute so a teardown stops the ladder", () => {
    expect(handler).toContain("signal: transferAbort.signal");
    expect(src).toContain("abortTransfer()");
  });
});

describe("the reach execute closure maps ladder details for the model", () => {
  const src = readFileSync(join(__dirname, "../vps/voice-bridge/src/index.ts"), "utf8");

  it("tells the model not to retry after nobody_answered", () => {
    expect(src).toContain("Do not call this tool again on this call");
  });

  it("forwards the AbortSignal and maps caller_gone without blaming the team", () => {
    expect(src).toContain("signal");
    expect(src).toContain('detail: "caller_gone"');
  });
});
