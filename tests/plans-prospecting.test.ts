import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  placesQueriesPerDayForTier,
  postalAddressRequiredForBusiness,
  postalAddressRequiredForTier,
  PROSPECTING_UPGRADE_MESSAGE,
  prospectingAllowedForBusiness,
  prospectingAllowedForTier,
  prospectingTierForBusiness
} from "@/lib/plans/prospecting";
import { QUERIES_PER_RUN } from "@/lib/outreach/discover";
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
      "prospectingTierForBusiness: db down"
    );
  });
});

describe("the postal-address gate by tier", () => {
  it("exempts Enterprise and requires it of everyone else", () => {
    expect(postalAddressRequiredForTier("enterprise")).toBe(false);
    expect(postalAddressRequiredForTier("standard")).toBe(true);
    expect(postalAddressRequiredForTier("starter")).toBe(true);
    // An unreadable or missing tier is NOT an exemption: guessing exempt
    // would drop a legally required footer line, so the default is strict.
    expect(postalAddressRequiredForTier(null)).toBe(true);
    expect(postalAddressRequiredForTier(undefined)).toBe(true);
  });

  it("resolves the waiver for a business from its tier", async () => {
    expect(
      await postalAddressRequiredForBusiness(
        "biz-1",
        makeDb({ data: { tier: "enterprise" }, error: null })
      )
    ).toBe(false);
    expect(
      await postalAddressRequiredForBusiness(
        "biz-1",
        makeDb({ data: { tier: "standard" }, error: null })
      )
    ).toBe(true);
  });

  it("reads the tier once, and reports a missing row as no tier", async () => {
    expect(
      await prospectingTierForBusiness("biz-1", makeDb({ data: { tier: "standard" }, error: null }))
    ).toBe("standard");
    expect(await prospectingTierForBusiness("biz-1", makeDb({ data: null, error: null }))).toBeNull();
    expect(
      await prospectingTierForBusiness("biz-1", makeDb({ data: { tier: null }, error: null }))
    ).toBeNull();
  });
});

describe("places query budget by tier", () => {
  it("gives Standard the base budget and Enterprise double", () => {
    expect(placesQueriesPerDayForTier("standard")).toBe(QUERIES_PER_RUN);
    expect(placesQueriesPerDayForTier("enterprise")).toBe(QUERIES_PER_RUN * 2);
    expect(placesQueriesPerDayForTier("standard")).toBe(6);
    expect(placesQueriesPerDayForTier("enterprise")).toBe(12);
  });

  it("falls back to the base budget for unknown or missing tiers", () => {
    // Starter never reaches discovery (the tier gate refuses it first), so
    // the base is a safe total-function answer, not a Starter allowance.
    expect(placesQueriesPerDayForTier("starter")).toBe(QUERIES_PER_RUN);
    expect(placesQueriesPerDayForTier(null)).toBe(QUERIES_PER_RUN);
    expect(placesQueriesPerDayForTier(undefined)).toBe(QUERIES_PER_RUN);
  });
});
