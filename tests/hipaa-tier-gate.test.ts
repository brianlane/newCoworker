import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  HIPAA_TIER_MESSAGE,
  HipaaValidationError,
  assertHipaaModeAllowed,
  hipaaAllowedForTier
} from "@/lib/hipaa/tier-gate";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "22222222-2222-4222-8222-222222222222";

/** Minimal from().select().eq().maybeSingle() chain returning a fixed result. */
function tierDb(result: { data?: unknown; error: { message: string } | null }) {
  const maybeSingle = vi.fn(async () => result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { db: { from } as never, from, select, eq };
}

describe("hipaa tier gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only the enterprise tier can carry the HIPAA lane", () => {
    expect(hipaaAllowedForTier("enterprise")).toBe(true);
    expect(hipaaAllowedForTier("standard")).toBe(false);
    expect(hipaaAllowedForTier("starter")).toBe(false);
    expect(hipaaAllowedForTier(null)).toBe(false);
    expect(hipaaAllowedForTier(undefined)).toBe(false);
  });

  it("lets an enterprise tenant turn it on", async () => {
    const { db, from } = tierDb({ data: { tier: "enterprise" }, error: null });
    await expect(assertHipaaModeAllowed(BIZ, true, db)).resolves.toBeUndefined();
    expect(from).toHaveBeenCalledWith("businesses");
  });

  it("refuses a non-enterprise tenant", async () => {
    const { db } = tierDb({ data: { tier: "standard" }, error: null });
    await expect(assertHipaaModeAllowed(BIZ, true, db)).rejects.toThrow(HipaaValidationError);
    await expect(assertHipaaModeAllowed(BIZ, true, db)).rejects.toThrow(HIPAA_TIER_MESSAGE);
  });

  it("refuses when the business row is missing entirely", async () => {
    const { db } = tierDb({ data: null, error: null });
    await expect(assertHipaaModeAllowed(BIZ, true, db)).rejects.toThrow(HipaaValidationError);
  });

  it("turning it OFF is always allowed and never reads the tier", async () => {
    // A downgraded tenant must never be wedged in a mode its plan no longer
    // supports, so the disable path short-circuits before any query.
    const { db, from } = tierDb({ data: { tier: "starter" }, error: null });
    await expect(assertHipaaModeAllowed(BIZ, false, db)).resolves.toBeUndefined();
    expect(from).not.toHaveBeenCalled();
  });

  it("surfaces a lookup error rather than silently allowing", async () => {
    const { db } = tierDb({ data: null, error: { message: "boom" } });
    await expect(assertHipaaModeAllowed(BIZ, true, db)).rejects.toThrow(
      "assertHipaaModeAllowed: boom"
    );
  });

  it("falls back to the service client when no client is supplied", async () => {
    const { db, from } = tierDb({ data: { tier: "enterprise" }, error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db);
    await expect(assertHipaaModeAllowed(BIZ, true)).resolves.toBeUndefined();
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(from).toHaveBeenCalledWith("businesses");
  });
});
