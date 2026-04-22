import { describe, it, expect } from "vitest";
import {
  resolveBridgeHealthState,
  BRIDGE_FRESHNESS_THRESHOLD_MS
} from "@/lib/telnyx/bridge-health";

const NOW = new Date("2026-04-21T20:00:00.000Z");

describe("resolveBridgeHealthState", () => {
  it("returns 'pending' when no heartbeat has been recorded", () => {
    expect(resolveBridgeHealthState(null, NOW)).toBe("pending");
    expect(resolveBridgeHealthState(undefined, NOW)).toBe("pending");
    expect(resolveBridgeHealthState("", NOW)).toBe("pending");
  });

  it("returns 'unknown' when the heartbeat string fails to parse", () => {
    expect(resolveBridgeHealthState("not-a-date", NOW)).toBe("unknown");
  });

  it("returns 'healthy' for heartbeats newer than the threshold", () => {
    const recent = new Date(NOW.getTime() - 30 * 1000).toISOString();
    expect(resolveBridgeHealthState(recent, NOW)).toBe("healthy");
  });

  it("returns 'stale' for heartbeats past the threshold", () => {
    const old = new Date(NOW.getTime() - BRIDGE_FRESHNESS_THRESHOLD_MS - 1).toISOString();
    expect(resolveBridgeHealthState(old, NOW)).toBe("stale");
  });

  it("treats an exactly-threshold-aged heartbeat as stale (strict <)", () => {
    const borderline = new Date(NOW.getTime() - BRIDGE_FRESHNESS_THRESHOLD_MS).toISOString();
    expect(resolveBridgeHealthState(borderline, NOW)).toBe("stale");
  });

  it("honours an explicit thresholdMs override", () => {
    const age = 5 * 60 * 1000;
    const ts = new Date(NOW.getTime() - age).toISOString();
    expect(resolveBridgeHealthState(ts, NOW, 10 * 60 * 1000)).toBe("healthy");
    expect(resolveBridgeHealthState(ts, NOW, 1 * 60 * 1000)).toBe("stale");
  });

  it("defaults `now` to Date.now() when omitted", () => {
    // Stale-by-a-year heartbeat must be classified stale regardless of the
    // actual wall clock.
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    expect(resolveBridgeHealthState(oneYearAgo)).toBe("stale");
  });
});
