import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  claimAvailableVps,
  claimOwnAssignedVps,
  claimSpecificAvailableVps,
  recordVpsAssigned,
  releaseVpsToPool,
  retireVps,
  retireLapsedPoolVps,
  getLastAcquiredAtForBusiness,
  getVpsInventoryByVmId,
  listVpsInventory,
  clearVpsNeverRenew,
  markVpsNeverRenew,
  refreshVpsInventoryExpiresAt,
  paidThroughFromBillingSub,
  hasPoolRunway,
  VPS_POOL_MIN_RUNWAY_MS,
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
  expires_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z"
};

type MockQB = {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  neq: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
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
    or: vi.fn(() => qb),
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
  describe("paidThroughFromBillingSub / hasPoolRunway", () => {
    it("prefers expires_at over next_billing_at", () => {
      expect(
        paidThroughFromBillingSub({
          expires_at: "2026-08-02T00:00:00Z",
          next_billing_at: "2026-09-01T00:00:00Z"
        })
      ).toBe("2026-08-02T00:00:00Z");
      expect(paidThroughFromBillingSub({ next_billing_at: "2026-09-01T00:00:00Z" })).toBe(
        "2026-09-01T00:00:00Z"
      );
      expect(paidThroughFromBillingSub({})).toBeNull();
    });

    it("treats null/unknown expiry as eligible and enforces the 72h floor", () => {
      const now = Date.parse("2026-07-29T00:00:00Z");
      expect(hasPoolRunway(null, now)).toBe(true);
      expect(hasPoolRunway("", now)).toBe(true);
      expect(hasPoolRunway("not-a-date", now)).toBe(true);
      expect(hasPoolRunway("2026-08-02T00:00:00Z", now)).toBe(true);
      expect(hasPoolRunway(new Date(now + VPS_POOL_MIN_RUNWAY_MS - 1).toISOString(), now)).toBe(
        false
      );
      expect(hasPoolRunway(new Date(now + VPS_POOL_MIN_RUNWAY_MS).toISOString(), now)).toBe(true);
    });
  });

  describe("claimOwnAssignedVps", () => {
    it("returns the box already assigned to this business", async () => {
      const chain = makeChain();
      const ownRow = { ...sampleRow, state: "assigned", assigned_business_id: "biz-1" };
      chain.limit.mockResolvedValueOnce({ data: [ownRow], error: null });
      const db = makeDb(chain);
      await expect(claimOwnAssignedVps("kvm2", "biz-1", db as never)).resolves.toEqual(ownRow);
      expect(chain.eq).toHaveBeenCalledWith("state", "assigned");
      expect(chain.eq).toHaveBeenCalledWith("assigned_business_id", "biz-1");
      expect(chain.eq).toHaveBeenCalledWith("plan", "kvm2");
    });

    it("returns null when this business holds nothing", async () => {
      const chain = makeChain();
      chain.limit.mockResolvedValueOnce({ data: [], error: null });
      const db = makeDb(chain);
      await expect(claimOwnAssignedVps("kvm2", "biz-1", db as never)).resolves.toBeNull();
    });

    it("uses the default service client when none is provided", async () => {
      const chain = makeChain();
      chain.limit.mockResolvedValueOnce({ data: [], error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await claimOwnAssignedVps("kvm2", "biz-1");
      expect(defaultClientSpy).toHaveBeenCalled();
    });
  });

  describe("claimAvailableVps", () => {
    it("claims the furthest-expiry available box and marks it assigned", async () => {
      const chain = makeChain();
      mockNoOwnBox(chain);
      chain.limit.mockResolvedValueOnce({
        data: [{ vm_id: 1800985, expires_at: "2026-09-01T00:00:00Z" }],
        error: null
      });
      chain.maybeSingle.mockResolvedValue({
        data: { ...sampleRow, state: "assigned", assigned_business_id: "biz-1" },
        error: null
      });
      const db = makeDb(chain);
      const row = await claimAvailableVps("kvm2", "biz-1", db as never);
      expect(row?.vm_id).toBe(1800985);
      expect(row?.state).toBe("assigned");
      expect(db.from).toHaveBeenCalledWith("vps_inventory");
      // Candidate scan filters on state + plan, furthest expiry first,
      // and pushes the 72h runway floor into the query so short-runway
      // boxes cannot crowd null-expiry inventory out of the LIMIT window.
      expect(chain.eq).toHaveBeenCalledWith("state", "available");
      expect(chain.eq).toHaveBeenCalledWith("plan", "kvm2");
      expect(chain.or).toHaveBeenCalledWith(
        expect.stringMatching(/^expires_at\.is\.null,expires_at\.gte\."\d{4}-/)
      );
      expect(chain.order).toHaveBeenCalledWith("expires_at", {
        ascending: false,
        nullsFirst: false
      });
      expect(chain.order).toHaveBeenCalledWith("acquired_at", { ascending: true });
      // The claim is the conditional UPDATE (race lock).
      const updateArg = chain.update.mock.calls[0][0];
      expect(updateArg.state).toBe("assigned");
      expect(updateArg.assigned_business_id).toBe("biz-1");
      expect(chain.eq).toHaveBeenCalledWith("vm_id", 1800985);
    });

    it("pushes the 72h runway floor into the query and claims the next eligible", async () => {
      const chain = makeChain();
      mockNoOwnBox(chain);
      const later = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
      chain.limit.mockResolvedValueOnce({
        // Query already excluded short-runway boxes; only eligible remain.
        data: [{ vm_id: 222, expires_at: later }],
        error: null
      });
      chain.maybeSingle.mockResolvedValue({
        data: { ...sampleRow, vm_id: 222, state: "assigned" },
        error: null
      });
      const db = makeDb(chain);
      const row = await claimAvailableVps("kvm2", "biz-1", db as never);
      expect(row?.vm_id).toBe(222);
      expect(chain.or).toHaveBeenCalledWith(
        expect.stringMatching(/^expires_at\.is\.null,expires_at\.gte\."/)
      );
      expect(chain.eq).toHaveBeenCalledWith("vm_id", 222);
    });

    it("returns null when the runway-filtered query finds no eligible boxes", async () => {
      const chain = makeChain();
      mockNoOwnBox(chain);
      chain.limit.mockResolvedValueOnce({
        data: [],
        error: null
      });
      const db = makeDb(chain);
      await expect(claimAvailableVps("kvm2", "biz-1", db as never)).resolves.toBeNull();
      expect(chain.or).toHaveBeenCalled();
      expect(chain.update).not.toHaveBeenCalled();
    });

    it("still drops a short-runway row client-side if the query filter is bypassed", async () => {
      const chain = makeChain();
      mockNoOwnBox(chain);
      const soon = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      chain.limit.mockResolvedValueOnce({
        data: [{ vm_id: 111, expires_at: soon }],
        error: null
      });
      const db = makeDb(chain);
      await expect(claimAvailableVps("kvm2", "biz-1", db as never)).resolves.toBeNull();
      expect(chain.update).not.toHaveBeenCalled();
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
      // The own-box scan lives in claimOwnAssignedVps since the V1-residual
      // fix; the error prefix names the function that actually ran the query.
      await expect(claimAvailableVps("kvm2", "biz-1", db as never)).rejects.toThrow(
        "claimOwnAssignedVps: own scan down"
      );
    });

    it("moves to the next candidate when a concurrent claim wins the first", async () => {
      const chain = makeChain();
      mockNoOwnBox(chain);
      chain.limit.mockResolvedValueOnce({
        data: [
          { vm_id: 111, expires_at: "2026-10-01T00:00:00Z" },
          { vm_id: 222, expires_at: "2026-09-01T00:00:00Z" }
        ],
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

  describe("claimSpecificAvailableVps", () => {
    it("claims the named available VM", async () => {
      const chain = makeChain();
      chain.maybeSingle
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({
          data: { ...sampleRow, state: "assigned", assigned_business_id: "biz-1" },
          error: null
        });
      const db = makeDb(chain);
      const row = await claimSpecificAvailableVps(1800985, "biz-1", db as never);
      expect(row?.vm_id).toBe(1800985);
      expect(chain.update).toHaveBeenCalled();
      expect(chain.eq).toHaveBeenCalledWith("vm_id", 1800985);
      expect(chain.eq).toHaveBeenCalledWith("state", "available");
    });

    it("returns the row when already assigned to this business", async () => {
      const chain = makeChain();
      const own = { ...sampleRow, state: "assigned", assigned_business_id: "biz-1" };
      chain.maybeSingle.mockResolvedValueOnce({ data: own, error: null });
      const db = makeDb(chain);
      await expect(claimSpecificAvailableVps(1800985, "biz-1", db as never)).resolves.toEqual(own);
      expect(chain.update).not.toHaveBeenCalled();
    });

    it("returns null when another provision already claimed it", async () => {
      const chain = makeChain();
      chain.maybeSingle
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: null, error: null });
      const db = makeDb(chain);
      await expect(claimSpecificAvailableVps(1800985, "biz-1", db as never)).resolves.toBeNull();
    });

    it("throws on own-scan error", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "own down" } });
      const db = makeDb(chain);
      await expect(claimSpecificAvailableVps(1, "biz-1", db as never)).rejects.toThrow(
        "claimSpecificAvailableVps: own down"
      );
    });

    it("throws on claim update error", async () => {
      const chain = makeChain();
      chain.maybeSingle
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: null, error: { message: "claim boom" } });
      const db = makeDb(chain);
      await expect(claimSpecificAvailableVps(1, "biz-1", db as never)).rejects.toThrow(
        "claimSpecificAvailableVps: claim boom"
      );
    });

    it("uses the default service client when none is provided", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValue({ data: null, error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await expect(claimSpecificAvailableVps(1, "biz-1")).resolves.toBeNull();
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

    it("stamps expires_at when the caller resolved a paid-through", async () => {
      const chain = makeChain();
      chain.upsert.mockResolvedValue({ error: null });
      const db = makeDb(chain);
      await recordVpsAssigned(
        {
          vmId: 42,
          plan: "kvm2",
          businessId: "biz-2",
          expiresAt: "2028-07-01T00:00:00Z"
        },
        db as never
      );
      expect(chain.upsert.mock.calls[0][0].expires_at).toBe("2028-07-01T00:00:00Z");
    });

    // The purchase path resolves paid-through best-effort. Omitting the key
    // (rather than sending null) is what stops a failed lookup on a RETRY
    // from erasing the runway an earlier successful run already recorded.
    it("omits expires_at entirely when the caller did not resolve one", async () => {
      const chain = makeChain();
      chain.upsert.mockResolvedValue({ error: null });
      const db = makeDb(chain);
      await recordVpsAssigned({ vmId: 42, plan: "kvm2", businessId: "biz-2" }, db as never);
      expect(chain.upsert.mock.calls[0][0]).not.toHaveProperty("expires_at");
    });

    // An EXPLICIT null is a caller saying "this box has no known expiry",
    // which must still be written; only `undefined` means "leave it alone".
    it("writes an explicit null expires_at through", async () => {
      const chain = makeChain();
      chain.upsert.mockResolvedValue({ error: null });
      const db = makeDb(chain);
      await recordVpsAssigned(
        { vmId: 42, plan: "kvm2", businessId: "biz-2", expiresAt: null },
        db as never
      );
      const payload = chain.upsert.mock.calls[0][0];
      expect(payload).toHaveProperty("expires_at");
      expect(payload.expires_at).toBeNull();
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
    it("stores expiresAt on update when provided, preserves it when omitted", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({
        data: { vm_id: 42, state: "assigned" },
        error: null
      });
      chain.neq.mockResolvedValueOnce({ error: null });
      const db = makeDb(chain);
      await releaseVpsToPool(
        {
          vmId: 42,
          plan: "kvm2",
          expiresAt: "2026-08-02T20:51:19Z"
        },
        db as never
      );
      expect(chain.update.mock.calls[0][0].expires_at).toBe("2026-08-02T20:51:19Z");
    });

    it("inserts expires_at on a pre-inventory box when provided", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
      chain.insert.mockResolvedValueOnce({ error: null });
      const db = makeDb(chain);
      await releaseVpsToPool(
        { vmId: 7, plan: "kvm8", expiresAt: "2026-09-01T00:00:00Z" },
        db as never
      );
      expect(chain.insert.mock.calls[0][0].expires_at).toBe("2026-09-01T00:00:00Z");
    });

    it("updates an already-tracked box to available WITHOUT touching its recorded plan", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({
        data: { vm_id: 42, state: "assigned" },
        error: null
      });
      // The write chain is .update(...).eq(...).neq(...), neq is terminal.
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
      // The recorded plan (captured at purchase/adopt) is ground truth,
      // a cancel-time caller's inferred label must never clobber it.
      expect(updateArg.plan).toBeUndefined();
      // Race guard: the conditional write skips rows retired in between.
      expect(chain.neq).toHaveBeenCalledWith("state", "retired");
      expect(chain.insert).not.toHaveBeenCalled();
    });

    it("never resurrects a retired row, a box gone upstream stays gone", async () => {
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

  /**
   * The reaper's retire, guarded on `state = 'available'`.
   *
   * retireVps above is unconditional because the adopt path legitimately
   * retires a row it holds as `assigned`. The billing-posture reaper decides
   * from an earlier snapshot instead, and claimSpecificAvailableVps can
   * assign any available row by id without consulting runway, so an
   * unguarded write could clear assigned_business_id out from under a live
   * signup.
   */
  describe("retireLapsedPoolVps", () => {
    it("retires the row and reports true when the guard matches", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({ data: { vm_id: 42 }, error: null });
      const db = makeDb(chain);

      await expect(
        retireLapsedPoolVps(42, "lapsed at Hostinger", db as never)
      ).resolves.toBe(true);

      const updateArg = chain.update.mock.calls[0][0];
      expect(updateArg.state).toBe("retired");
      expect(updateArg.assigned_business_id).toBeNull();
      expect(updateArg.notes).toBe("lapsed at Hostinger");
      expect(chain.eq).toHaveBeenCalledWith("vm_id", 42);
      // The guard itself: without this the write would also hit a row a
      // provision had just claimed.
      expect(chain.eq).toHaveBeenCalledWith("state", "available");
    });

    it("reports false when the row is no longer available, without erroring", async () => {
      const chain = makeChain();
      // PostgREST returns no error for an update matching zero rows, which is
      // exactly why the caller has to read the boolean.
      chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
      const db = makeDb(chain);

      await expect(retireLapsedPoolVps(42, "x", db as never)).resolves.toBe(false);
    });

    it("throws on Supabase error", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({ error: { message: "guard boom" } });
      const db = makeDb(chain);
      await expect(retireLapsedPoolVps(42, "x", db as never)).rejects.toThrow(
        /retireLapsedPoolVps: guard boom/
      );
    });

    it("uses the default service client when none is provided", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValueOnce({ data: { vm_id: 42 }, error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await retireLapsedPoolVps(42, "x");
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

  describe("getLastAcquiredAtForBusiness", () => {
    // acquired_at is the purchase stamp (recordVpsAssigned omits it from the
    // upsert so it takes default now() on insert and survives conflict), which
    // is what makes it readable after a migration that bought a box and then
    // failed.
    it("returns the newest acquired_at for a business's assigned box", async () => {
      const chain = makeChain();
      chain.limit.mockReturnValueOnce(chain);
      chain.maybeSingle.mockResolvedValueOnce({
        data: { acquired_at: "2026-07-29T11:01:00.000Z" },
        error: null
      });
      const db = makeDb(chain);
      await expect(getLastAcquiredAtForBusiness("biz-1", db as never)).resolves.toEqual(
        new Date("2026-07-29T11:01:00.000Z")
      );
      expect(db.from).toHaveBeenCalledWith("vps_inventory");
      expect(chain.eq).toHaveBeenCalledWith("assigned_business_id", "biz-1");
      expect(chain.order).toHaveBeenCalledWith("acquired_at", { ascending: false });
    });

    it("returns null when the business has no assigned box", async () => {
      const chain = makeChain();
      chain.limit.mockReturnValueOnce(chain);
      chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
      const db = makeDb(chain);
      await expect(getLastAcquiredAtForBusiness("biz-1", db as never)).resolves.toBeNull();
    });

    it("returns null when the row carries no acquired_at", async () => {
      const chain = makeChain();
      chain.limit.mockReturnValueOnce(chain);
      chain.maybeSingle.mockResolvedValueOnce({ data: { acquired_at: null }, error: null });
      const db = makeDb(chain);
      await expect(getLastAcquiredAtForBusiness("biz-1", db as never)).resolves.toBeNull();
    });

    // An unparseable stamp must read as "no record", not as an Invalid Date
    // that every comparison against it silently answers false.
    it("returns null when acquired_at will not parse", async () => {
      const chain = makeChain();
      chain.limit.mockReturnValueOnce(chain);
      chain.maybeSingle.mockResolvedValueOnce({ data: { acquired_at: "nope" }, error: null });
      const db = makeDb(chain);
      await expect(getLastAcquiredAtForBusiness("biz-1", db as never)).resolves.toBeNull();
    });

    it("throws on Supabase error", async () => {
      const chain = makeChain();
      chain.limit.mockReturnValueOnce(chain);
      chain.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "acq boom" } });
      const db = makeDb(chain);
      await expect(getLastAcquiredAtForBusiness("biz-1", db as never)).rejects.toThrow(
        /getLastAcquiredAtForBusiness: acq boom/
      );
    });

    it("uses the default service client when none is provided", async () => {
      const chain = makeChain();
      chain.limit.mockReturnValueOnce(chain);
      chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await expect(getLastAcquiredAtForBusiness("biz-1")).resolves.toBeNull();
      expect(defaultClientSpy).toHaveBeenCalled();
    });
  });

  describe("markVpsNeverRenew", () => {
    it("sets never_renew on the inventory row", async () => {
      const chain = makeChain();
      chain.eq.mockResolvedValueOnce({ error: null });
      const db = makeDb(chain);
      await markVpsNeverRenew(1800985, db as never);
      expect(db.from).toHaveBeenCalledWith("vps_inventory");
      expect(chain.update).toHaveBeenCalledWith(
        expect.objectContaining({ never_renew: true })
      );
      expect(chain.eq).toHaveBeenCalledWith("vm_id", 1800985);
    });

    it("throws on Supabase error", async () => {
      const chain = makeChain();
      chain.eq.mockResolvedValueOnce({ error: { message: "update boom" } });
      const db = makeDb(chain);
      await expect(markVpsNeverRenew(1800985, db as never)).rejects.toThrow(
        /markVpsNeverRenew: update boom/
      );
    });

    it("uses the default service client when none is provided", async () => {
      const chain = makeChain();
      chain.eq.mockResolvedValueOnce({ error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await markVpsNeverRenew(1800985);
      expect(defaultClientSpy).toHaveBeenCalled();
    });
  });

  describe("clearVpsNeverRenew", () => {
    it("clears never_renew on the inventory row", async () => {
      const chain = makeChain();
      chain.eq.mockResolvedValueOnce({ error: null });
      const db = makeDb(chain);
      await clearVpsNeverRenew(1864812, db as never);
      expect(db.from).toHaveBeenCalledWith("vps_inventory");
      expect(chain.update).toHaveBeenCalledWith(
        expect.objectContaining({ never_renew: false })
      );
      expect(chain.eq).toHaveBeenCalledWith("vm_id", 1864812);
    });

    it("throws on Supabase error", async () => {
      const chain = makeChain();
      chain.eq.mockResolvedValueOnce({ error: { message: "clear boom" } });
      const db = makeDb(chain);
      await expect(clearVpsNeverRenew(1864812, db as never)).rejects.toThrow(
        /clearVpsNeverRenew: clear boom/
      );
    });

    it("uses the default service client when none is provided", async () => {
      const chain = makeChain();
      chain.eq.mockResolvedValueOnce({ error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await clearVpsNeverRenew(1864812);
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

  describe("refreshVpsInventoryExpiresAt", () => {
    it("updates rows whose paid-through differs from the live billing sub", async () => {
      const chain = makeChain();
      chain.neq.mockResolvedValue({ error: null });
      const db = makeDb(chain);
      const updated = await refreshVpsInventoryExpiresAt(
        [
          {
            vm_id: 1800980,
            state: "available",
            hostinger_billing_subscription_id: "sub-a",
            expires_at: null
          },
          {
            vm_id: 1815606,
            state: "assigned",
            hostinger_billing_subscription_id: "sub-b",
            expires_at: "2026-08-08T22:52:18Z"
          },
          {
            vm_id: 1,
            state: "retired",
            hostinger_billing_subscription_id: "sub-c",
            expires_at: null
          }
        ],
        [
          { id: "sub-a", expires_at: "2026-08-02T20:51:19Z" },
          { id: "sub-b", next_billing_at: "2026-08-08T22:52:18Z" }
        ],
        db as never
      );
      expect(updated).toBe(1);
      expect(chain.update).toHaveBeenCalledTimes(1);
      expect(chain.update.mock.calls[0][0].expires_at).toBe("2026-08-02T20:51:19Z");
      expect(chain.eq).toHaveBeenCalledWith("vm_id", 1800980);
    });

    it("throws on update error", async () => {
      const chain = makeChain();
      chain.neq.mockResolvedValue({ error: { message: "refresh boom" } });
      const db = makeDb(chain);
      await expect(
        refreshVpsInventoryExpiresAt(
          [
            {
              vm_id: 1,
              state: "available",
              hostinger_billing_subscription_id: "sub-a",
              expires_at: null
            }
          ],
          [{ id: "sub-a", expires_at: "2026-08-02T00:00:00Z" }],
          db as never
        )
      ).rejects.toThrow(/refreshVpsInventoryExpiresAt: refresh boom/);
    });

    it("skips rows with no billing sub, unknown sub, or unchanged expiry", async () => {
      const chain = makeChain();
      chain.neq.mockResolvedValue({ error: null });
      const db = makeDb(chain);
      const updated = await refreshVpsInventoryExpiresAt(
        [
          {
            vm_id: 1,
            state: "available",
            hostinger_billing_subscription_id: null,
            expires_at: null
          },
          {
            vm_id: 2,
            state: "available",
            hostinger_billing_subscription_id: "missing",
            expires_at: null
          },
          {
            vm_id: 3,
            state: "available",
            hostinger_billing_subscription_id: "sub-same",
            expires_at: "2026-08-02T00:00:00Z"
          }
        ],
        [{ id: "sub-same", expires_at: "2026-08-02T00:00:00Z" }],
        db as never
      );
      expect(updated).toBe(0);
      expect(chain.update).not.toHaveBeenCalled();
    });

    it("does not clear a known expires_at when the billing sub has no paid-through", async () => {
      const chain = makeChain();
      chain.neq.mockResolvedValue({ error: null });
      const db = makeDb(chain);
      const updated = await refreshVpsInventoryExpiresAt(
        [
          {
            vm_id: 4,
            state: "available",
            hostinger_billing_subscription_id: "sub-empty",
            expires_at: "2026-08-02T00:00:00Z"
          }
        ],
        [{ id: "sub-empty" }],
        db as never
      );
      expect(updated).toBe(0);
      expect(chain.update).not.toHaveBeenCalled();
    });

    it("builds the default service client when none is passed", async () => {
      const chain = makeChain();
      chain.neq.mockResolvedValue({ error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      const updated = await refreshVpsInventoryExpiresAt(
        [
          {
            vm_id: 9,
            state: "available",
            hostinger_billing_subscription_id: "sub-z",
            expires_at: null
          }
        ],
        [{ id: "sub-z", next_billing_at: "2026-09-01T00:00:00Z" }]
      );
      expect(updated).toBe(1);
      expect(defaultClientSpy).toHaveBeenCalled();
      expect(chain.update.mock.calls[0][0].expires_at).toBe("2026-09-01T00:00:00Z");
    });
  });
});
