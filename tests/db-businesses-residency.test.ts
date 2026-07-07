import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

// The gate's own behavior (tier lookup, supabase-mode bypass) is covered in
// tests/residency-tier-gate.test.ts; here it is mocked so these tests pin the
// WRITE path: gate consulted first, update only on pass.
vi.mock("@/lib/residency/tier-gate", () => ({
  assertResidencyModeAllowed: vi.fn()
}));

import { updateDataResidencyMode } from "@/lib/db/businesses";
import { assertResidencyModeAllowed } from "@/lib/residency/tier-gate";
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
