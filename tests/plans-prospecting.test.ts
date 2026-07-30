import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  PROSPECTING_UPGRADE_MESSAGE,
  prospectingAllowedForBusiness,
  prospectingAllowedForTier
} from "@/lib/plans/prospecting";
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

describe("prospecting tier gate", () => {
  it("allows standard and enterprise only", () => {
    expect(prospectingAllowedForTier("standard")).toBe(true);
    expect(prospectingAllowedForTier("enterprise")).toBe(true);
    expect(prospectingAllowedForTier("starter")).toBe(false);
    expect(prospectingAllowedForTier(null)).toBe(false);
    expect(prospectingAllowedForTier(undefined)).toBe(false);
  });

  it("exposes an upgrade message naming Standard", () => {
    expect(PROSPECTING_UPGRADE_MESSAGE).toContain("Standard");
  });

  it("resolves the tier for a business via the provided client", async () => {
    const db = makeDb({ data: { tier: "standard" }, error: null });
    expect(await prospectingAllowedForBusiness("biz-1", db)).toBe(true);

    const starter = makeDb({ data: { tier: "starter" }, error: null });
    expect(await prospectingAllowedForBusiness("biz-1", starter)).toBe(false);

    const missing = makeDb({ data: null, error: null });
    expect(await prospectingAllowedForBusiness("biz-1", missing)).toBe(false);
  });

  it("creates a service client when none is provided", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({ data: { tier: "enterprise" }, error: null })
    );
    expect(await prospectingAllowedForBusiness("biz-1")).toBe(true);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("throws on lookup errors", async () => {
    const db = makeDb({ data: null, error: { message: "db down" } });
    await expect(prospectingAllowedForBusiness("biz-1", db)).rejects.toThrow(
      "prospectingAllowedForBusiness: db down"
    );
  });
});
