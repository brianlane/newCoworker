import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  TRANSLATOR_UPGRADE_MESSAGE,
  translatorAllowedForBusiness,
  translatorAllowedForTier
} from "@/lib/plans/translator";
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

describe("translator tier gate", () => {
  it("allows standard and enterprise only", () => {
    expect(translatorAllowedForTier("standard")).toBe(true);
    expect(translatorAllowedForTier("enterprise")).toBe(true);
    expect(translatorAllowedForTier("starter")).toBe(false);
    expect(translatorAllowedForTier(null)).toBe(false);
    expect(translatorAllowedForTier(undefined)).toBe(false);
  });

  it("exposes an upgrade message naming Standard", () => {
    expect(TRANSLATOR_UPGRADE_MESSAGE).toContain("Standard");
  });

  it("resolves the tier for a business via the provided client", async () => {
    const db = makeDb({ data: { tier: "standard" }, error: null });
    expect(await translatorAllowedForBusiness("biz-1", db)).toBe(true);

    const starter = makeDb({ data: { tier: "starter" }, error: null });
    expect(await translatorAllowedForBusiness("biz-1", starter)).toBe(false);

    const missing = makeDb({ data: null, error: null });
    expect(await translatorAllowedForBusiness("biz-1", missing)).toBe(false);
  });

  it("creates a service client when none is provided", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({ data: { tier: "enterprise" }, error: null })
    );
    expect(await translatorAllowedForBusiness("biz-1")).toBe(true);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("throws on lookup errors", async () => {
    const db = makeDb({ data: null, error: { message: "db down" } });
    await expect(translatorAllowedForBusiness("biz-1", db)).rejects.toThrow(
      "translatorAllowedForBusiness: db down"
    );
  });
});
