import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { pushAllowedForBusiness } from "@/lib/push/tier-gate";

const BIZ = "11111111-1111-1111-1111-111111111111";

function makeDb(result: { data?: unknown; error?: { message: string } | null }) {
  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: result.data ?? null,
      error: result.error ?? null
    })
  };
  return { from: vi.fn(() => builder) };
}

beforeEach(() => vi.clearAllMocks());

/**
 * The pure tier predicate is module-private, so every tier is driven through
 * the resolver that production actually calls.
 */
describe("push/tier-gate: which tiers may receive push", () => {
  async function allowedForTier(tier: string | null) {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(makeDb({ data: { tier } }) as never);
    return pushAllowedForBusiness(BIZ);
  }

  it.each(["standard", "enterprise"])("allows %s", async (tier) => {
    expect(await allowedForTier(tier)).toBe(true);
  });

  it.each([["starter"], ["trial"], [null], [""]])("refuses %s", async (tier) => {
    expect(await allowedForTier(tier as string | null)).toBe(false);
  });
});

describe("push/tier-gate: pushAllowedForBusiness", () => {
  it("resolves the tier from the business row", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({ data: { tier: "standard" } }) as never
    );
    expect(await pushAllowedForBusiness(BIZ)).toBe(true);
  });

  it("refuses a starter tenant", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({ data: { tier: "starter" } }) as never
    );
    expect(await pushAllowedForBusiness(BIZ)).toBe(false);
  });

  it("refuses when the business row is missing", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(makeDb({ data: null }) as never);
    expect(await pushAllowedForBusiness(BIZ)).toBe(false);
  });

  /**
   * Throws rather than returning false. The caller decides the fail
   * direction: deliverPush catches this and delivers anyway, because an alert
   * must not be lost to a transient tier-read blip, while the subscribe route
   * lets it surface as a 500 rather than silently registering a device it may
   * not be allowed to.
   */
  it("throws on a read error instead of guessing", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({ error: { message: "pg down" } }) as never
    );
    await expect(pushAllowedForBusiness(BIZ)).rejects.toThrow("pushAllowedForBusiness: pg down");
  });

  it("uses a caller-supplied client when given one", async () => {
    const db = makeDb({ data: { tier: "enterprise" } });
    expect(await pushAllowedForBusiness(BIZ, db as never)).toBe(true);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});
