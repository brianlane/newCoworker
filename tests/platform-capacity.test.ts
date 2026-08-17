import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_CHANNEL_LIMIT,
  DEFAULT_OUTBOUND_HEADROOM,
  platformMaxConcurrentOutbound
} from "../supabase/functions/_shared/platform_capacity";

/**
 * The fleet gate derivation: ONE knob (the granted Telnyx account pool)
 * minus a headroom reserve for the legs the platform does not meter at dial
 * time (warm transfers, reach_teammate B legs). The clamp to >= 1 is the
 * safety property: a misconfigured pair degrades to one-at-a-time dialing,
 * never to a fleet that can't call at all.
 */
describe("platformMaxConcurrentOutbound", () => {
  const env =
    (vals: Record<string, string | undefined>) =>
    (name: string): string | undefined =>
      vals[name];

  it("derives limit minus headroom from the env", () => {
    expect(
      platformMaxConcurrentOutbound(
        env({ TELNYX_ACCOUNT_CHANNEL_LIMIT: "50", PLATFORM_OUTBOUND_HEADROOM: "5" })
      )
    ).toBe(45);
  });

  it("defaults to the Level 2 pool of 10 minus 3 headroom", () => {
    expect(DEFAULT_ACCOUNT_CHANNEL_LIMIT).toBe(10);
    expect(DEFAULT_OUTBOUND_HEADROOM).toBe(3);
    expect(platformMaxConcurrentOutbound(env({}))).toBe(7);
  });

  it("floors fractional values", () => {
    expect(
      platformMaxConcurrentOutbound(
        env({ TELNYX_ACCOUNT_CHANNEL_LIMIT: "10.9", PLATFORM_OUTBOUND_HEADROOM: "2.7" })
      )
    ).toBe(8);
  });

  it("clamps to at least 1 when headroom swallows the pool", () => {
    expect(
      platformMaxConcurrentOutbound(
        env({ TELNYX_ACCOUNT_CHANNEL_LIMIT: "2", PLATFORM_OUTBOUND_HEADROOM: "3" })
      )
    ).toBe(1);
    expect(
      platformMaxConcurrentOutbound(
        env({ TELNYX_ACCOUNT_CHANNEL_LIMIT: "3", PLATFORM_OUTBOUND_HEADROOM: "3" })
      )
    ).toBe(1);
  });

  it("falls back to defaults on garbage or negative values", () => {
    expect(
      platformMaxConcurrentOutbound(
        env({ TELNYX_ACCOUNT_CHANNEL_LIMIT: "lots", PLATFORM_OUTBOUND_HEADROOM: "-2" })
      )
    ).toBe(7);
    expect(
      platformMaxConcurrentOutbound(
        env({ TELNYX_ACCOUNT_CHANNEL_LIMIT: " ", PLATFORM_OUTBOUND_HEADROOM: "" })
      )
    ).toBe(7);
  });

  it("treats zero headroom as a real choice (gate = the full pool)", () => {
    expect(
      platformMaxConcurrentOutbound(
        env({ TELNYX_ACCOUNT_CHANNEL_LIMIT: "10", PLATFORM_OUTBOUND_HEADROOM: "0" })
      )
    ).toBe(10);
  });
});
