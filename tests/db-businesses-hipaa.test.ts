import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

// The gate's own behavior (tier lookup, disable bypass) is covered in
// tests/hipaa-tier-gate.test.ts; here it is mocked so these tests pin the
// WRITE path: gate consulted first, update only on pass.
vi.mock("@/lib/hipaa/tier-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hipaa/tier-gate")>();
  return {
    ...actual,
    assertHipaaModeAllowed: vi.fn()
  };
});

import { updateBusinessHipaaMode } from "@/lib/db/businesses";
import { assertHipaaModeAllowed } from "@/lib/hipaa/tier-gate";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

function mockDb() {
  return {
    from: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue({ error: null })
  };
}

describe("updateBusinessHipaaMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertHipaaModeAllowed).mockResolvedValue(undefined);
  });

  it("consults the tier gate before writing", async () => {
    const db = mockDb();
    await updateBusinessHipaaMode("uuid-biz-1", true, db as never);
    expect(assertHipaaModeAllowed).toHaveBeenCalledWith("uuid-biz-1", true, db);
    expect(db.from).toHaveBeenCalledWith("businesses");
    expect(db.update).toHaveBeenCalledWith({ hipaa_mode: true });
    expect(db.eq).toHaveBeenCalledWith("id", "uuid-biz-1");
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("writes the disable the same way", async () => {
    const db = mockDb();
    await updateBusinessHipaaMode("uuid-biz-1", false, db as never);
    expect(db.update).toHaveBeenCalledWith({ hipaa_mode: false });
  });

  it("does not write when the gate rejects", async () => {
    const db = mockDb();
    vi.mocked(assertHipaaModeAllowed).mockRejectedValue(new Error("not enterprise"));
    await expect(updateBusinessHipaaMode("uuid-biz-1", true, db as never)).rejects.toThrow(
      "not enterprise"
    );
    expect(db.update).not.toHaveBeenCalled();
  });

  it("falls back to the service client and throws on write error", async () => {
    const db = mockDb();
    db.eq.mockResolvedValue({ error: { message: "write failed" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(updateBusinessHipaaMode("uuid-biz-1", true)).rejects.toThrow(
      "updateBusinessHipaaMode: write failed"
    );
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});
