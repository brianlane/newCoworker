import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import { updateBusinessVpsProvider } from "@/lib/db/businesses";
import { VPS_PROVIDER_TIER_MESSAGE } from "@/lib/vps/provider";

/**
 * Fake supabase client covering both chains the setter uses:
 *   read  — from("businesses").select().eq("id", id).single()
 *   write — from("businesses").update(patch).eq("id", id)
 */
function mockDb(opts: {
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
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ single })
      }),
      update
    })
  };
  return { db, update };
}

describe("updateBusinessVpsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes provider + region for an enterprise business", async () => {
    const { db, update } = mockDb({ business: { id: "biz-1", tier: "enterprise" } });
    await updateBusinessVpsProvider("biz-1", "byos", "ca", db as never);
    expect(update).toHaveBeenCalledWith({ vps_provider: "byos", vps_region: "ca" });
  });

  it("rejects non-hostinger providers on non-enterprise tiers (gate before write)", async () => {
    const { db, update } = mockDb({ business: { id: "biz-1", tier: "standard" } });
    await expect(
      updateBusinessVpsProvider("biz-1", "ovh", "ca", db as never)
    ).rejects.toThrow(VPS_PROVIDER_TIER_MESSAGE);
    expect(update).not.toHaveBeenCalled();
  });

  it("always allows reverting to hostinger (downgraded tenant can never be wedged)", async () => {
    const { db, update } = mockDb({ business: { id: "biz-1", tier: "starter" } });
    await updateBusinessVpsProvider("biz-1", "hostinger", "us", db as never);
    expect(update).toHaveBeenCalledWith({ vps_provider: "hostinger", vps_region: "us" });
  });

  it("throws when the business does not exist", async () => {
    const { db, update } = mockDb({ business: null });
    await expect(
      updateBusinessVpsProvider("missing", "byos", "us", db as never)
    ).rejects.toThrow(/business missing not found/);
    expect(update).not.toHaveBeenCalled();
  });

  it("falls back to the service client and surfaces write errors", async () => {
    const { db } = mockDb({
      business: { id: "biz-1", tier: "enterprise" },
      writeError: { message: "boom" }
    });
    defaultClientSpy.mockReturnValue(db);
    await expect(updateBusinessVpsProvider("biz-1", "byos", "us")).rejects.toThrow(
      "updateBusinessVpsProvider: boom"
    );
    expect(defaultClientSpy).toHaveBeenCalledTimes(1);
  });
});
