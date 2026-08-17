import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACCOUNT_CHANNEL_LIMIT,
  DEFAULT_OUTBOUND_HEADROOM,
  TELNYX_CAPACITY_SETTINGS_KEY,
  gateFromConfig,
  parseTelnyxCapacityConfig,
  platformMaxConcurrentOutbound,
  readTelnyxCapacityConfig
} from "../supabase/functions/_shared/platform_capacity";

/**
 * The fleet gate config: the granted Telnyx pool lives in
 * admin_platform_settings (it changes as support tickets land; one row
 * update applies everywhere), env is the fallback, then hard defaults. The
 * clamp to >= 1 is the safety property: a misconfigured pair degrades to
 * one-at-a-time dialing, never a fleet that can't call at all.
 */

const noEnv = (): string | undefined => undefined;
const env =
  (vals: Record<string, string | undefined>) =>
  (name: string): string | undefined =>
    vals[name];

describe("parseTelnyxCapacityConfig + gateFromConfig", () => {
  it("reads the settings row shape", () => {
    const config = parseTelnyxCapacityConfig(
      { account_channel_limit: 100, platform_outbound_headroom: 3 },
      noEnv
    );
    expect(config).toEqual({ accountChannelLimit: 100, platformOutboundHeadroom: 3 });
    expect(gateFromConfig(config)).toBe(97);
  });

  it("falls back per-field to env, then defaults", () => {
    expect(
      parseTelnyxCapacityConfig(
        { account_channel_limit: 100 },
        env({ PLATFORM_OUTBOUND_HEADROOM: "5" })
      )
    ).toEqual({ accountChannelLimit: 100, platformOutboundHeadroom: 5 });
    expect(parseTelnyxCapacityConfig(null, noEnv)).toEqual({
      accountChannelLimit: DEFAULT_ACCOUNT_CHANNEL_LIMIT,
      platformOutboundHeadroom: DEFAULT_OUTBOUND_HEADROOM
    });
  });

  it("rejects garbage values field by field (blank env must not parse as 0)", () => {
    expect(
      parseTelnyxCapacityConfig(
        { account_channel_limit: "lots", platform_outbound_headroom: -2 },
        env({ TELNYX_ACCOUNT_CHANNEL_LIMIT: " ", PLATFORM_OUTBOUND_HEADROOM: "" })
      )
    ).toEqual({
      accountChannelLimit: DEFAULT_ACCOUNT_CHANNEL_LIMIT,
      platformOutboundHeadroom: DEFAULT_OUTBOUND_HEADROOM
    });
  });

  it("floors fractional values and clamps the gate to at least 1", () => {
    const config = parseTelnyxCapacityConfig(
      { account_channel_limit: 10.9, platform_outbound_headroom: 2.7 },
      noEnv
    );
    expect(config).toEqual({ accountChannelLimit: 10, platformOutboundHeadroom: 2 });
    expect(gateFromConfig({ accountChannelLimit: 2, platformOutboundHeadroom: 3 })).toBe(1);
    expect(gateFromConfig({ accountChannelLimit: 10, platformOutboundHeadroom: 0 })).toBe(10);
  });
});

describe("readTelnyxCapacityConfig", () => {
  function settingsDb(result: { data: unknown; error: { message: string } | null } | "throw") {
    return {
      from: (table: string) => {
        expect(table).toBe("admin_platform_settings");
        return {
          select: () => ({
            eq: (col: string, key: unknown) => {
              expect(col).toBe("key");
              expect(key).toBe(TELNYX_CAPACITY_SETTINGS_KEY);
              return {
                maybeSingle: async () => {
                  if (result === "throw") throw new Error("db down");
                  return result;
                }
              };
            }
          })
        };
      }
    };
  }

  it("reads the row and derives the gate", async () => {
    const config = await readTelnyxCapacityConfig(
      settingsDb({
        data: { value: { account_channel_limit: 100, platform_outbound_headroom: 3 } },
        error: null
      }),
      noEnv
    );
    expect(config.accountChannelLimit).toBe(100);
    expect(gateFromConfig(config)).toBe(97);
  });

  it("degrades to env then defaults on a missing row, a read error, or a throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fallbackEnv = env({ TELNYX_ACCOUNT_CHANNEL_LIMIT: "50" });
    expect(
      (await readTelnyxCapacityConfig(settingsDb({ data: null, error: null }), fallbackEnv))
        .accountChannelLimit
    ).toBe(50);
    expect(
      (
        await readTelnyxCapacityConfig(
          settingsDb({ data: null, error: { message: "boom" } }),
          noEnv
        )
      ).accountChannelLimit
    ).toBe(DEFAULT_ACCOUNT_CHANNEL_LIMIT);
    expect(
      (await readTelnyxCapacityConfig(settingsDb("throw"), noEnv)).accountChannelLimit
    ).toBe(DEFAULT_ACCOUNT_CHANNEL_LIMIT);
    vi.restoreAllMocks();
  });
});

describe("platformMaxConcurrentOutbound (env-only back-compat)", () => {
  it("derives the gate from env alone", () => {
    expect(
      platformMaxConcurrentOutbound(
        env({ TELNYX_ACCOUNT_CHANNEL_LIMIT: "50", PLATFORM_OUTBOUND_HEADROOM: "5" })
      )
    ).toBe(45);
    expect(platformMaxConcurrentOutbound(noEnv)).toBe(
      DEFAULT_ACCOUNT_CHANNEL_LIMIT - DEFAULT_OUTBOUND_HEADROOM
    );
  });
});
