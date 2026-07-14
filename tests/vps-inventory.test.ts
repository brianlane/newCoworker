import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  claimAvailableVps,
  recordVpsAssigned,
  releaseVpsToPool,
  retireVps,
  getVpsInventoryByVmId,
  listVpsInventory,
  type VpsInventoryRow
} from "@/lib/db/vps-inventory";

const sampleRow: VpsInventoryRow = {
  vm_id: 1800985,
  hostname: "srv1800985.hstgr.cloud",
  plan: "kvm2",
  state: "available",
  hostinger_billing_subscription_id: null,
  assigned_business_id: null,
  acquired_at: "2026-07-01T00:00:00Z",
  assigned_at: null,
  notes: null,
  never_renew: false,
  updated_at: "2026-07-01T00:00:00Z"
};

type MockQB = {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  neq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function makeChain(): MockQB {
  const qb: MockQB = {
    select: vi.fn(() => qb),
    update: vi.fn(() => qb),
    insert: vi.fn(),
    upsert: vi.fn(),
    eq: vi.fn(() => qb),
    neq: vi.fn(),
    order: vi.fn(() => qb),
    limit: vi.fn(),
    maybeSingle: vi.fn()
  };
  return qb;
}

function makeDb(chain: MockQB) {
  return { from: vi.fn(() => chain) };
}

/** Own-box re-claim scan comes first; resolve it empty for the common path. */
function mockNoOwnBox(chain: MockQB) {
  chain.limit.mockResolvedValueOnce({ data: [], error: null });
}

describe("vps_inventory DB layer", () => {
  describe("claimAvailableVps", () => {
    it("claims the oldest available box and marks it assigned", async () => {
      const chain = makeChain();
      mockNoOwnBox(chain);
      chain.limit.mockResolvedValueOnce({ data: [{ vm_id: 1800985 }], error: null });
      chain.maybeSingle.mockResolvedValue({
        data: { ...sampleRow, state: "assigned", assigned_business_id: "biz-1" },
        error: null
      });
      const db = makeDb(chain);
      const row = await claimAvailableVps("kvm2", "biz-1", db as never);
      expect(row?.vm_id).toBe(1800985);
      expect(row?.state).toBe("assigned");
      expect(db.from).toHaveBeenCalledWith("vps_inventory");
      // Candidate scan filters on state + plan, oldest first.
      expect(chain.eq).toHaveBeenCalledWith("state", "available");
      expect(chain.eq).toHaveBeenCalledWith("plan", "kvm2");
      expect(chain.order).toHaveBeenCalledWith("acquired_at", { ascending: true });
      // The claim is the conditional UPDATE (race lock).
      const updateArg = chain.update.mock.calls[0][0];
      expect(updateArg.state).toBe("assigned");
      expect(updateArg.assigned_business_id).toBe("biz-1");
      expect(chain.eq).toHaveBeenCalledWith("vm_id", 1800985);
    });

    it("returns the box THIS business already claimed (dead-attempt retry) without re-updating", async () => {
      const chain = makeChain();
      const ownRow = { ...sampleRow, state: "assigned", assigned_business_id: "biz-1" };
      chain.limit.mockResolvedValueOnce({ data: [ownRow], error: null });
      const db = makeDb(chain);
      const row = await claimAvailableVps("kvm2", "biz-1", db as never);
      expect(row).toEqual(ownRow);
      // Straight return: no conditional-claim UPDATE, no purchase fallback.
      expect(chain.update).not.toHaveBeenCalled();
      expect(chain.eq).toHaveBeenCalledWith("assigned_business_id", "biz-1");
    });

    it("throws when the own-box scan errors", async () => {
      const chain = makeChain();
      chain.limit.mockResolvedValueOnce({ data: null, error: { message: "own scan down" } });
      const db = makeDb(chain);
      await expect(claimAvailableVps("kvm2", "biz-1", db as never)).rejects.toThrow(
        "claimAvailableVps: own scan down"
      );
    });

    it("moves to the next candidate when a concurrent claim wins the first", async () => {
      const chain = makeChain();
      mockNoOwnBox(chain);
      chain.limit.mockResolvedValueOnce({
        data: [{ vm_id: 111 }, { vm_id: 222 }],
        error: null
      });
      chain.maybeSingle
        // First candidate: another provision claimed it between the scan and
        // our conditional update → zero rows matched.
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({
          data: { ...sampleRow, vm_id: 222, state: "assigned" },
          error: null
        });
      const db = makeDb(chain);
      const row = await claimAvailableVps("kvm2", "biz-1", db as never);
      expect(row?.vm_id).toBe(222);
    });

    it("returns null when the pool has no matching-size box", async () => {
      const chain = makeChain();
      mockNoOwnBox(chain);
      chain.limit.mockResolvedValueOnce({ data: [], error: null });
      const db = makeDb(chain);
      await expect(claimAvailableVps("kvm8", "biz-1", db as never)).resolves.toBeNull();
    });

    it("returns null when candidates is null (own scan null-data tolerated too)", async () => {
      const chain = makeChain();
      chain.limit.mockResolvedValueOnce({ data: null, error: null });
      chain.limit.mockResolvedValueOnce({ data: null, error: null });
      const db = makeDb(chain);
      await expect(claimAvailableVps("kvm2", "biz-1", db as never)).resolves.toBeNull();
    });

    it("returns null when every candidate loses the race", async () => {
      const chain = makeChain();
      mockNoOwnBox(chain);
      chain.limit.mockResolvedValueOnce({ data: [{ vm_id: 111 }], error: null });
      chain.maybeSingle.mockResolvedValue({ data: null, error: null });
      const db = makeDb(chain);
      await expect(claimAvailableVps("kvm2", "biz-1", db as never)).resolves.toBeNull();
    });

    it("throws when the candidate scan errors", async () => {
      const chain = makeChain();
      mockNoOwnBox(chain);
      chain.limit.mockResolvedValueOnce({ data: null, error: { message: "scan boom" } });
      const db = makeDb(chain);
      await expect(claimAvailableVps("kvm2", "biz-1", db as never)).rejects.toThrow(
        /claimAvailableVps: scan boom/
      );
    });

    it("throws when the claim update errors", async () => {
      const chain = makeChain();
      mockNoOwnBox(chain);
      chain.limit.mockResolvedValueOnce({ data: [{ vm_id: 111 }], error: null });
      chain.maybeSingle.mockResolvedValue({ data: null, error: { message: "claim boom" } });
      const db = makeDb(chain);
      await expect(claimAvailableVps("kvm2", "biz-1", db as never)).rejects.toThrow(
        /claimAvailableVps: claim boom/
      );
    });

    it("uses the default service client when none is provided", async () => {
      const chain = makeChain();
      chain.limit.mockResolvedValue({ data: [], error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await expect(claimAvailableVps("kvm2", "biz-1")).resolves.toBeNull();
      expect(defaultClientSpy).toHaveBeenCalled();
    });
  });

  describe("recordVpsAssigned", () => {
    it("upserts the box as assigned with derived hostname and defaults", async () => {
      const chain = makeChain();
      chain.upsert.mockResolvedValue({ error: null });
      const db = makeDb(chain);
      await recordVpsAssigned({ vmId: 42, plan: "kvm8", businessId: "biz-2" }, db as never);
      const [payload, opts] = chain.upsert.mock.calls[0];
      expect(payload.vm_id).toBe(42);
      expect(payload.plan).toBe("kvm8");
      expect(payload.state).toBe("assigned");
      expect(payload.assigned_business_id).toBe("biz-2");
      expect(payload.hostname).toBe("srv42.hstgr.cloud");
      expect(payload.hostinger_billing_subscription_id).toBeNull();
      expect(payload.notes).toBeNull();
      expect(opts).toEqual({ onConflict: "vm_id" });
    });

    it("passes explicit hostname, billing id and notes through", async () => {
      const chain = makeChain();
      chain.upsert.mockResolvedValue({ error: null });
      const db = makeDb(chain);
      await recordVpsAssigned(
        {
          vmId: 42,
          plan: "kvm2",
          businessId: "biz-2",
          hostname: "custom.host",
          hostingerBillingSubscriptionId: "sub-1",
          notes: "purchased for biz-2"
        },
        db as never
      );
      const payload = chain.upsert.mock.calls[0][0];
      expect(payload.hostname).toBe("custom.host");
      expect(payload.hostinger_billing_subscription_id).toBe("sub-1");
      expect(payload.notes).toBe("purchased for biz-2");
    });

    it("throws on Supabase error", async () => {
      const chain = makeChain();
      chain.upsert.mockResolvedValue({ error: { message: "upsert boom" } });
      const db = makeDb(chain);
      await expect(
        recordVpsAssigned({ vmId: 1, plan: "kvm2", businessId: "b" }, db as never)
      ).rejects.toThrow(/recordVpsAssigned: upsert boom/);
    });

    it("uses the default service client when none is provided", async () => {
      const chain = makeChain();
      chain.upsert.mockResolvedValue({ error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await recordVpsAssigned({ vmId: 1, plan: "kvm2", businessId: "b" });
      expect(defaultClientSpy).toHaveBeenCalled();
    });
  });

  describe("releaseVpsToPool", () => {
    it("updates an already-tracked box to available WITHOUT touching its recorded plan", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({
        data: { vm_id: 42, state: "assigned" },
        error: null
      });
      // The write chain is .update(...).eq(...).neq(...) — neq is terminal.
      chain.neq.mockResolvedValueOnce({ error: null });
      const db = makeDb(chain);
      await releaseVpsToPool(
        { vmId: 42, plan: "kvm2", hostingerBillingSubscriptionId: "sub-9", notes: "canceled" },
        db as never
      );
      const updateArg = chain.update.mock.calls[0][0];
      expect(updateArg.state).toBe("available");
      expect(updateArg.assigned_business_id).toBeNull();
      expect(updateArg.assigned_at).toBeNull();
      expect(updateArg.hostinger_billing_subscription_id).toBe("sub-9");
      expect(updateArg.notes).toBe("canceled");
      // The recorded plan (captured at purchase/adopt) is ground truth —
      // a cancel-time caller's inferred label must never clobber it.
      expect(updateArg.plan).toBeUndefined();
      // Race guard: the conditional write skips rows retired in between.
      expect(chain.neq).toHaveBeenCalledWith("state", "retired");
      expect(chain.insert).not.toHaveBeenCalled();
    });

    it("never resurrects a retired row — a box gone upstream stays gone", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({
        data: { vm_id: 42, state: "retired" },
        error: null
      });
      const db = makeDb(chain);
      await releaseVpsToPool({ vmId: 42, plan: "kvm2" }, db as never);
      expect(chain.update).not.toHaveBeenCalled();
      expect(chain.insert).not.toHaveBeenCalled();
    });

    it("inserts a pre-inventory box with the caller's plan label and defaults", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
      chain.insert.mockResolvedValueOnce({ error: null });
      const db = makeDb(chain);
      await releaseVpsToPool({ vmId: 7, plan: "kvm8" }, db as never);
      const payload = chain.insert.mock.calls[0][0];
      expect(payload.vm_id).toBe(7);
      expect(payload.plan).toBe("kvm8");
      expect(payload.state).toBe("available");
      expect(payload.hostname).toBe("srv7.hstgr.cloud");
      expect(payload.hostinger_billing_subscription_id).toBeNull();
      expect(payload.notes).toBeNull();
    });

    it("passes an explicit hostname through on insert", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
      chain.insert.mockResolvedValueOnce({ error: null });
      const db = makeDb(chain);
      await releaseVpsToPool({ vmId: 7, plan: "kvm8", hostname: "my.host" }, db as never);
      expect(chain.insert.mock.calls[0][0].hostname).toBe("my.host");
    });

    it("throws when the existence read errors", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "read boom" } });
      const db = makeDb(chain);
      await expect(releaseVpsToPool({ vmId: 7, plan: "kvm2" }, db as never)).rejects.toThrow(
        /releaseVpsToPool: read boom/
      );
    });

    it("throws when the update errors", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({
        data: { vm_id: 7, state: "assigned" },
        error: null
      });
      chain.neq.mockResolvedValueOnce({ error: { message: "update boom" } });
      const db = makeDb(chain);
      await expect(releaseVpsToPool({ vmId: 7, plan: "kvm2" }, db as never)).rejects.toThrow(
        /releaseVpsToPool: update boom/
      );
    });

    it("throws when the insert errors", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
      chain.insert.mockResolvedValueOnce({ error: { message: "insert boom" } });
      const db = makeDb(chain);
      await expect(releaseVpsToPool({ vmId: 7, plan: "kvm2" }, db as never)).rejects.toThrow(
        /releaseVpsToPool: insert boom/
      );
    });

    it("uses the default service client when none is provided", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
      chain.insert.mockResolvedValueOnce({ error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await releaseVpsToPool({ vmId: 7, plan: "kvm2" });
      expect(defaultClientSpy).toHaveBeenCalled();
    });
  });

  describe("retireVps", () => {
    it("marks the row retired with the reason and clears the business", async () => {
      const chain = makeChain();
      chain.eq.mockResolvedValueOnce({ error: null });
      const db = makeDb(chain);
      await retireVps(42, "lapsed at Hostinger", db as never);
      const updateArg = chain.update.mock.calls[0][0];
      expect(updateArg.state).toBe("retired");
      expect(updateArg.assigned_business_id).toBeNull();
      expect(updateArg.notes).toBe("lapsed at Hostinger");
      expect(chain.eq).toHaveBeenCalledWith("vm_id", 42);
    });

    it("throws on Supabase error", async () => {
      const chain = makeChain();
      chain.eq.mockResolvedValueOnce({ error: { message: "retire boom" } });
      const db = makeDb(chain);
      await expect(retireVps(42, "x", db as never)).rejects.toThrow(/retireVps: retire boom/);
    });

    it("uses the default service client when none is provided", async () => {
      const chain = makeChain();
      chain.eq.mockResolvedValueOnce({ error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await retireVps(42, "x");
      expect(defaultClientSpy).toHaveBeenCalled();
    });
  });

  describe("getVpsInventoryByVmId", () => {
    it("returns the row for a tracked VM", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({
        data: { ...sampleRow, never_renew: true },
        error: null
      });
      const db = makeDb(chain);
      const row = await getVpsInventoryByVmId(1800985, db as never);
      expect(row?.never_renew).toBe(true);
      expect(db.from).toHaveBeenCalledWith("vps_inventory");
      expect(chain.eq).toHaveBeenCalledWith("vm_id", 1800985);
    });

    it("returns null for a VM the inventory never tracked", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
      const db = makeDb(chain);
      await expect(getVpsInventoryByVmId(42, db as never)).resolves.toBeNull();
    });

    it("throws on Supabase error", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "get boom" } });
      const db = makeDb(chain);
      await expect(getVpsInventoryByVmId(42, db as never)).rejects.toThrow(
        /getVpsInventoryByVmId: get boom/
      );
    });

    it("uses the default service client when none is provided", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({ data: sampleRow, error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await expect(getVpsInventoryByVmId(1800985)).resolves.toEqual(sampleRow);
      expect(defaultClientSpy).toHaveBeenCalled();
    });
  });

  describe("listVpsInventory", () => {
    it("returns all rows newest-acquired first", async () => {
      const chain = makeChain();
      chain.order.mockResolvedValueOnce({ data: [sampleRow], error: null });
      const db = makeDb(chain);
      await expect(listVpsInventory(db as never)).resolves.toEqual([sampleRow]);
      expect(chain.order).toHaveBeenCalledWith("acquired_at", { ascending: false });
    });

    it("returns an empty array when the table is empty", async () => {
      const chain = makeChain();
      chain.order.mockResolvedValueOnce({ data: null, error: null });
      const db = makeDb(chain);
      await expect(listVpsInventory(db as never)).resolves.toEqual([]);
    });

    it("throws on Supabase error", async () => {
      const chain = makeChain();
      chain.order.mockResolvedValueOnce({ data: null, error: { message: "list boom" } });
      const db = makeDb(chain);
      await expect(listVpsInventory(db as never)).rejects.toThrow(/listVpsInventory: list boom/);
    });

    it("uses the default service client when none is provided", async () => {
      const chain = makeChain();
      chain.order.mockResolvedValueOnce({ data: [sampleRow], error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await expect(listVpsInventory()).resolves.toEqual([sampleRow]);
      expect(defaultClientSpy).toHaveBeenCalled();
    });
  });
});
