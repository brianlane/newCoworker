import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  MARKETING_AUTOMATION_UPGRADE_MESSAGE,
  marketingAutomationAllowedForBusiness,
  marketingAutomationAllowedForTier
} from "@/lib/plans/marketing-automation";
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

describe("marketing automation tier gate", () => {
  it("allows standard and enterprise only", () => {
    expect(marketingAutomationAllowedForTier("standard")).toBe(true);
    expect(marketingAutomationAllowedForTier("enterprise")).toBe(true);
    expect(marketingAutomationAllowedForTier("starter")).toBe(false);
    expect(marketingAutomationAllowedForTier(null)).toBe(false);
  });

  it("exposes an upgrade message naming Standard", () => {
    expect(MARKETING_AUTOMATION_UPGRADE_MESSAGE).toContain("Standard");
  });

  it("resolves the tier for a business", async () => {
    expect(
      await marketingAutomationAllowedForBusiness(
        "biz-1",
        makeDb({ data: { tier: "standard" }, error: null })
      )
    ).toBe(true);
    expect(
      await marketingAutomationAllowedForBusiness(
        "biz-1",
        makeDb({ data: { tier: "starter" }, error: null })
      )
    ).toBe(false);
  });

  it("creates a service client when none is provided", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({ data: { tier: "enterprise" }, error: null })
    );
    expect(await marketingAutomationAllowedForBusiness("biz-1")).toBe(true);
  });

  it("throws on lookup errors", async () => {
    await expect(
      marketingAutomationAllowedForBusiness(
        "biz-1",
        makeDb({ data: null, error: { message: "db down" } })
      )
    ).rejects.toThrow("marketingAutomationAllowedForBusiness: db down");
  });
});
