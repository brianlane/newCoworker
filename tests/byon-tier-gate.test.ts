import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  assertByonAllowedForBusiness,
  byonAllowedForTier,
  BYON_UPGRADE_MESSAGE
} from "@/lib/byon/tier-gate";
import { ByonValidationError } from "@/lib/byon/port-requests";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";

/** Minimal from().select().eq().maybeSingle() chain returning a fixed result. */
function tierDb(result: { data?: unknown; error: { message: string } | null }) {
  const maybeSingle = vi.fn(async () => result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { db: { from } as never, from, select, eq };
}

describe("byonAllowedForTier", () => {
  it("allows standard and enterprise only", () => {
    expect(byonAllowedForTier("standard")).toBe(true);
    expect(byonAllowedForTier("enterprise")).toBe(true);
    expect(byonAllowedForTier("starter")).toBe(false);
    expect(byonAllowedForTier(null)).toBe(false);
    expect(byonAllowedForTier(undefined)).toBe(false);
  });
});

describe("assertByonAllowedForBusiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves for a standard-tier business (explicit client)", async () => {
    const { db, from, eq } = tierDb({ data: { tier: "standard" }, error: null });
    await expect(assertByonAllowedForBusiness(BIZ, db)).resolves.toBeUndefined();
    expect(from).toHaveBeenCalledWith("businesses");
    expect(eq).toHaveBeenCalledWith("id", BIZ);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("throws the upgrade prompt for starter businesses", async () => {
    const { db } = tierDb({ data: { tier: "starter" }, error: null });
    await expect(assertByonAllowedForBusiness(BIZ, db)).rejects.toThrow(ByonValidationError);
    await expect(assertByonAllowedForBusiness(BIZ, db)).rejects.toThrow(BYON_UPGRADE_MESSAGE);
  });

  it("throws the upgrade prompt when the business row is missing", async () => {
    const { db } = tierDb({ data: null, error: null });
    await expect(assertByonAllowedForBusiness(BIZ, db)).rejects.toThrow(BYON_UPGRADE_MESSAGE);
  });

  it("surfaces query errors as plain errors (500, not an upsell)", async () => {
    const { db } = tierDb({ data: null, error: { message: "db down" } });
    const err = await assertByonAllowedForBusiness(BIZ, db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ByonValidationError);
    expect((err as Error).message).toContain("db down");
  });

  it("falls back to the service client when none is provided", async () => {
    const { db } = tierDb({ data: { tier: "enterprise" }, error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db);
    await expect(assertByonAllowedForBusiness(BIZ)).resolves.toBeUndefined();
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});
