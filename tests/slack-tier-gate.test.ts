/**
 * Tests for the Slack Standard+ tier gate (src/lib/slack/tier-gate.ts).
 */
import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  slackAllowedForBusiness,
  slackAllowedForTier,
  SLACK_UPGRADE_MESSAGE
} from "@/lib/slack/tier-gate";

const BIZ = "11111111-1111-4111-8111-111111111111";

function dbReturningTier(result: { data: unknown; error: { message: string } | null }) {
  const c = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    maybeSingle: vi.fn(async () => result)
  };
  return { from: vi.fn(() => c) } as never;
}

describe("slackAllowedForTier", () => {
  it("allows exactly standard and enterprise", () => {
    expect(slackAllowedForTier("standard")).toBe(true);
    expect(slackAllowedForTier("enterprise")).toBe(true);
    expect(slackAllowedForTier("starter")).toBe(false);
    expect(slackAllowedForTier(null)).toBe(false);
    expect(slackAllowedForTier(undefined)).toBe(false);
    expect(slackAllowedForTier("something")).toBe(false);
  });

  it("exports an upgrade message naming the plans", () => {
    expect(SLACK_UPGRADE_MESSAGE).toMatch(/Standard and Enterprise/);
  });
});

describe("slackAllowedForBusiness", () => {
  it("resolves the tier through the provided client", async () => {
    expect(
      await slackAllowedForBusiness(BIZ, dbReturningTier({ data: { tier: "standard" }, error: null }))
    ).toBe(true);
    expect(
      await slackAllowedForBusiness(BIZ, dbReturningTier({ data: { tier: "starter" }, error: null }))
    ).toBe(false);
    expect(
      await slackAllowedForBusiness(BIZ, dbReturningTier({ data: null, error: null }))
    ).toBe(false);
  });

  it("falls back to the default service client when none is passed", async () => {
    defaultClientSpy.mockReturnValue(
      dbReturningTier({ data: { tier: "enterprise" }, error: null })
    );
    expect(await slackAllowedForBusiness(BIZ)).toBe(true);
  });

  it("throws on a read error rather than guessing", async () => {
    await expect(
      slackAllowedForBusiness(BIZ, dbReturningTier({ data: null, error: { message: "boom" } }))
    ).rejects.toThrow(/slackAllowedForBusiness: boom/);
  });
});
