import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  SCHEDULED_SMS_MAX_DAYS_AHEAD,
  SMS_TOOLS_UPGRADE_MESSAGE,
  smsToolsAllowedForBusiness,
  smsToolsAllowedForTier
} from "@/lib/plans/sms-tools";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

function makeDb(result: { data: unknown; error: { message: string } | null }) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(result)
        })
      })
    })
  } as unknown as Awaited<ReturnType<typeof createSupabaseServiceClient>>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sms-tools tier gate", () => {
  it("allows standard and enterprise only", () => {
    expect(smsToolsAllowedForTier("standard")).toBe(true);
    expect(smsToolsAllowedForTier("enterprise")).toBe(true);
    expect(smsToolsAllowedForTier("starter")).toBe(false);
    expect(smsToolsAllowedForTier(null)).toBe(false);
    expect(smsToolsAllowedForTier(undefined)).toBe(false);
  });

  it("exposes a schedule horizon and an upgrade message", () => {
    expect(SCHEDULED_SMS_MAX_DAYS_AHEAD).toBeGreaterThan(0);
    expect(SMS_TOOLS_UPGRADE_MESSAGE).toContain("Standard");
  });

  it("resolves the tier for a business via the provided client", async () => {
    const db = makeDb({ data: { tier: "standard" }, error: null });
    expect(await smsToolsAllowedForBusiness("biz-1", db)).toBe(true);

    const starter = makeDb({ data: { tier: "starter" }, error: null });
    expect(await smsToolsAllowedForBusiness("biz-1", starter)).toBe(false);

    const missing = makeDb({ data: null, error: null });
    expect(await smsToolsAllowedForBusiness("biz-1", missing)).toBe(false);
  });

  it("creates a service client when none is provided", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({ data: { tier: "enterprise" }, error: null })
    );
    expect(await smsToolsAllowedForBusiness("biz-1")).toBe(true);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("throws on lookup errors", async () => {
    const db = makeDb({ data: null, error: { message: "db down" } });
    await expect(smsToolsAllowedForBusiness("biz-1", db)).rejects.toThrow(
      "smsToolsAllowedForBusiness: db down"
    );
  });
});
