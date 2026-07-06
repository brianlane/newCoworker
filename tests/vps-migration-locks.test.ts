import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import { tryClaimVpsMigration, releaseVpsMigrationLock } from "@/lib/db/vps-migration-locks";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeDb(rpcResult: { data?: unknown; error?: { message: string } | null }) {
  return { rpc: vi.fn(async () => ({ data: null, error: null, ...rpcResult })) };
}

describe("vps-migration-locks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tryClaimVpsMigration", () => {
    it("returns true when the RPC grants the lease", async () => {
      const db = makeDb({ data: true });
      defaultClientSpy.mockReturnValue(db);
      await expect(tryClaimVpsMigration(BIZ_ID, "admin@example.com", "kvm4")).resolves.toBe(true);
      expect(db.rpc).toHaveBeenCalledWith("try_claim_vps_migration", {
        p_business_id: BIZ_ID,
        p_requested_by: "admin@example.com",
        p_target_size: "kvm4"
      });
    });

    it("returns false when a lease is already held", async () => {
      defaultClientSpy.mockReturnValue(makeDb({ data: false }));
      await expect(tryClaimVpsMigration(BIZ_ID, "admin@example.com", "kvm4")).resolves.toBe(false);
    });

    it("throws on RPC error", async () => {
      defaultClientSpy.mockReturnValue(makeDb({ error: { message: "db down" } }));
      await expect(tryClaimVpsMigration(BIZ_ID, "admin@example.com", "kvm4")).rejects.toThrow(
        "tryClaimVpsMigration: db down"
      );
    });

    it("uses an injected client instead of the default", async () => {
      const db = makeDb({ data: true });
      await expect(
        tryClaimVpsMigration(BIZ_ID, "admin@example.com", "kvm4", db as never)
      ).resolves.toBe(true);
      expect(defaultClientSpy).not.toHaveBeenCalled();
    });
  });

  describe("releaseVpsMigrationLock", () => {
    it("calls the release RPC", async () => {
      const db = makeDb({});
      defaultClientSpy.mockReturnValue(db);
      await releaseVpsMigrationLock(BIZ_ID);
      expect(db.rpc).toHaveBeenCalledWith("release_vps_migration_lock", {
        p_business_id: BIZ_ID
      });
    });

    it("throws on RPC error", async () => {
      defaultClientSpy.mockReturnValue(makeDb({ error: { message: "db down" } }));
      await expect(releaseVpsMigrationLock(BIZ_ID)).rejects.toThrow(
        "releaseVpsMigrationLock: db down"
      );
    });

    it("uses an injected client instead of the default", async () => {
      const db = makeDb({});
      await releaseVpsMigrationLock(BIZ_ID, db as never);
      expect(defaultClientSpy).not.toHaveBeenCalled();
    });
  });
});
