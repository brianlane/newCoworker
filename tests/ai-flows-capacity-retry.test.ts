import { describe, expect, it } from "vitest";
import {
  CAPACITY_RETRY_DELAYS_MINUTES,
  CAPACITY_RETRY_JITTER_MS,
  capacityRetryCountVar,
  capacityRetryPlan
} from "../supabase/functions/_shared/ai_flows/capacity_retry";

/**
 * The bounded backoff for Telnyx capacity-rejected dials (2026-08-16
 * incident). The schedule is the contract: flows rely on "deferred, then
 * retried a few times, THEN not_placed(carrier_capacity)" to never burn a
 * ladder rung on a transient channel-limit blip.
 */
describe("capacityRetryPlan", () => {
  it("defers on the documented schedule, in order", () => {
    expect(CAPACITY_RETRY_DELAYS_MINUTES).toEqual([2, 5, 12]);
    for (let i = 0; i < CAPACITY_RETRY_DELAYS_MINUTES.length; i++) {
      const plan = capacityRetryPlan(i, () => 0);
      expect(plan).toEqual({
        kind: "defer",
        delayMs: CAPACITY_RETRY_DELAYS_MINUTES[i]! * 60_000,
        retriesSoFar: i
      });
    }
  });

  it("gives up after the schedule is exhausted", () => {
    expect(capacityRetryPlan(CAPACITY_RETRY_DELAYS_MINUTES.length)).toEqual({ kind: "give_up" });
    expect(capacityRetryPlan(99)).toEqual({ kind: "give_up" });
  });

  it("adds bounded jitter from the injected rand", () => {
    const zero = capacityRetryPlan(0, () => 0);
    const half = capacityRetryPlan(0, () => 0.5);
    const full = capacityRetryPlan(0, () => 1);
    if (zero.kind !== "defer" || half.kind !== "defer" || full.kind !== "defer") {
      throw new Error("expected defers");
    }
    expect(zero.delayMs).toBe(120_000);
    expect(half.delayMs).toBe(120_000 + CAPACITY_RETRY_JITTER_MS / 2);
    expect(full.delayMs).toBe(120_000 + CAPACITY_RETRY_JITTER_MS);
  });

  it("clamps a misbehaving rand and normalizes a garbage retry count", () => {
    const neg = capacityRetryPlan(Number.NaN, () => -1);
    if (neg.kind !== "defer") throw new Error("expected defer");
    expect(neg.delayMs).toBe(120_000);
    expect(neg.retriesSoFar).toBe(0);
    const frac = capacityRetryPlan(1.9, () => 0);
    if (frac.kind !== "defer") throw new Error("expected defer");
    // floor(): a fractional persisted counter never skips a rung.
    expect(frac.retriesSoFar).toBe(1);
    expect(frac.delayMs).toBe(300_000);
  });
});

describe("capacityRetryCountVar", () => {
  it("derives from the step marker so two call steps count independently", () => {
    expect(capacityRetryCountVar("__called_ai_call_1")).toBe(
      "__called_ai_call_1_capacity_retries"
    );
    expect(capacityRetryCountVar("m2")).not.toBe(capacityRetryCountVar("m1"));
  });
});
