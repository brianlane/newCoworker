import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

// The gate's own behavior (tier lookup, supabase-mode bypass) is covered in
// tests/residency-tier-gate.test.ts; here it is mocked so these tests pin the
// WRITE path: gate consulted first, update only on pass. The rest of the
// module (residencyAllowedForTier, error class, message) stays REAL because
// updateResidencyBackupDestination consumes them directly.
vi.mock("@/lib/residency/tier-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/residency/tier-gate")>();
  return {
    ...actual,
    assertResidencyModeAllowed: vi.fn()
  };
});

import {
  updateDataResidencyMode,
  updateResidencyBackupDestination
} from "@/lib/db/businesses";
import { assertResidencyModeAllowed, RESIDENCY_TIER_MESSAGE } from "@/lib/residency/tier-gate";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

function mockDb() {
  return {
    from: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue({ error: null })
  };
}

describe("updateDataResidencyMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertResidencyModeAllowed).mockResolvedValue(undefined);
  });

  it("consults the tier gate before writing", async () => {
    const db = mockDb();
    await updateDataResidencyMode("uuid-biz-1", "dual", db as never);
    expect(assertResidencyModeAllowed).toHaveBeenCalledWith("uuid-biz-1", "dual", db);
    expect(db.from).toHaveBeenCalledWith("businesses");
    expect(db.update).toHaveBeenCalledWith({ data_residency_mode: "dual" });
    expect(db.eq).toHaveBeenCalledWith("id", "uuid-biz-1");
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("does not write when the gate rejects", async () => {
    const db = mockDb();
    vi.mocked(assertResidencyModeAllowed).mockRejectedValue(new Error("not enterprise"));
    await expect(
      updateDataResidencyMode("uuid-biz-1", "vps", db as never)
    ).rejects.toThrow("not enterprise");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("falls back to the service client and throws on write error", async () => {
    const db = {
      ...mockDb(),
      eq: vi.fn().mockResolvedValue({ error: { message: "boom" } })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(updateDataResidencyMode("uuid-biz-1", "supabase")).rejects.toThrow(
      "updateDataResidencyMode"
    );
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("updateResidencyBackupDestination", () => {
  beforeEach(() => vi.clearAllMocks());

  /** Handles both the read chain (select→eq→single) and the write chain (update→eq). */
  function mockDbWithBusiness(opts: {
    business: Record<string, unknown> | null;
    writeError?: { message: string } | null;
  }) {
    const single = vi.fn().mockResolvedValue(
      opts.business
        ? { data: opts.business, error: null }
        : { data: null, error: { message: "0 rows" } }
    );
    const update = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: opts.writeError ?? null })
    });
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single }) }),
        update
      })
    };
    return { db, update, single };
  }

  it("onbox: enterprise-gated, then writes the destination", async () => {
    const { db, update } = mockDbWithBusiness({
      business: { id: "biz-1", tier: "enterprise" }
    });
    await updateResidencyBackupDestination("biz-1", "onbox", db as never);
    expect(update).toHaveBeenCalledWith({ residency_backup_destination: "onbox" });
  });

  it("onbox: rejected for non-enterprise tiers and missing businesses", async () => {
    const gated = mockDbWithBusiness({ business: { id: "biz-1", tier: "standard" } });
    await expect(
      updateResidencyBackupDestination("biz-1", "onbox", gated.db as never)
    ).rejects.toThrow(RESIDENCY_TIER_MESSAGE);
    expect(gated.update).not.toHaveBeenCalled();

    const missing = mockDbWithBusiness({ business: null });
    await expect(
      updateResidencyBackupDestination("gone", "onbox", missing.db as never)
    ).rejects.toThrow(/business gone not found/);
  });

  it("reverting to central skips the tier read entirely (never wedged)", async () => {
    const { db, update, single } = mockDbWithBusiness({
      business: { id: "biz-1", tier: "starter" }
    });
    await updateResidencyBackupDestination("biz-1", "central", db as never);
    expect(single).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ residency_backup_destination: "central" });
  });

  it("surfaces write errors and uses the default client when none is passed", async () => {
    const { db } = mockDbWithBusiness({
      business: { id: "biz-1", tier: "enterprise" },
      writeError: { message: "boom" }
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(updateResidencyBackupDestination("biz-1", "onbox")).rejects.toThrow(
      "updateResidencyBackupDestination: boom"
    );
    expect(createSupabaseServiceClient).toHaveBeenCalled();

    const central = mockDbWithBusiness({ business: { id: "biz-1", tier: "starter" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(central.db as never);
    await updateResidencyBackupDestination("biz-1", "central");
    expect(central.update).toHaveBeenCalledWith({ residency_backup_destination: "central" });
  });
});
