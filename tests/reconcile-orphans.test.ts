import { describe, expect, it, vi } from "vitest";
import {
  normalizeHostingerPlan,
  reconcileOrphanedPurchases,
  reconcileUntilSizeMatch,
  resolveOrphanBillingSubscriptionId,
  orphanMatchesPurchaseAttempt,
  ORPHAN_MAX_AGE_MS,
  ORPHAN_RECONCILE_RETRY_INTERVAL_MS,
  ORPHAN_RECONCILE_RETRY_BUDGET_MS,
  ORPHAN_RECONCILE_MAX_CONSECUTIVE_FAILURES
} from "@/lib/provisioning/reconcile-orphans";
import type { VirtualMachine } from "@/lib/hostinger/client";
import { defaultPurchaseHostname } from "@/lib/hostinger/provision";

const NOW = Date.parse("2026-07-08T23:00:00Z");

function vm(overrides: Partial<VirtualMachine> & { id: number }): VirtualMachine {
  return {
    state: "initial",
    plan: "KVM 2",
    hostname: `srv${overrides.id}.hstgr.cloud`,
    created_at: new Date(NOW - 5 * 60 * 1000).toISOString(), // 5 min old
    ...overrides
  } as VirtualMachine;
}

describe("normalizeHostingerPlan", () => {
  it("maps Hostinger's human labels to VpsSize slugs", () => {
    expect(normalizeHostingerPlan("KVM 2")).toBe("kvm2");
    expect(normalizeHostingerPlan("KVM 1")).toBe("kvm1");
    expect(normalizeHostingerPlan("kvm8")).toBe("kvm8");
    expect(normalizeHostingerPlan("KVM-4")).toBe("kvm4");
  });

  it("returns null for unknown or missing plans", () => {
    expect(normalizeHostingerPlan("Cloud Startup")).toBeNull();
    expect(normalizeHostingerPlan("KVM 16")).toBeNull();
    expect(normalizeHostingerPlan("")).toBeNull();
    expect(normalizeHostingerPlan(undefined)).toBeNull();
    expect(normalizeHostingerPlan(null)).toBeNull();
  });
});

describe("resolveOrphanBillingSubscriptionId", () => {
  it("prefers the VM detail subscription_id", () => {
    expect(
      resolveOrphanBillingSubscriptionId(
        { id: 1, subscription_id: "from-vm" },
        [{ id: "from-list", resource_id: "1" }]
      )
    ).toBe("from-vm");
  });

  it("falls back to the billing list resource_id match when VM omits it", () => {
    expect(
      resolveOrphanBillingSubscriptionId({ id: 1863856, subscription_id: undefined }, [
        { id: "6olQFVQi75HF2es2", resource_id: "1863856" },
        { id: "other", resource_id: "999" }
      ])
    ).toBe("6olQFVQi75HF2es2");
  });

  it("returns null when neither source has a match", () => {
    expect(resolveOrphanBillingSubscriptionId({ id: 1 }, null)).toBeNull();
    expect(resolveOrphanBillingSubscriptionId({ id: 1 }, [])).toBeNull();
    expect(
      resolveOrphanBillingSubscriptionId({ id: 1, subscription_id: "" }, [
        { id: "x", resource_id: "2" }
      ])
    ).toBeNull();
  });
});

describe("reconcileOrphanedPurchases", () => {
  function makeArgs(overrides: Partial<Parameters<typeof reconcileOrphanedPurchases>[0]> = {}) {
    return {
      businessId: "biz-orphan-1",
      listVirtualMachines: vi.fn().mockResolvedValue([]),
      listInventory: vi.fn().mockResolvedValue([]),
      release: vi.fn().mockResolvedValue("pooled" as const),
      now: () => NOW,
      ...overrides
    };
  }

  it("pools a recent unknown VM and returns it with its normalized plan", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({ id: 1815606, subscription_id: "AzywqVVOpCob62ZiY" })
      ])
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(result).toEqual([
      {
        vmId: 1815606,
        plan: "kvm2",
        hostingerBillingSubscriptionId: "AzywqVVOpCob62ZiY",
        createdAtMs: NOW - 5 * 60 * 1000
      }
    ]);
    expect(args.release).toHaveBeenCalledWith(
      expect.objectContaining({
        vmId: 1815606,
        plan: "kvm2",
        hostname: "srv1815606.hstgr.cloud",
        hostingerBillingSubscriptionId: "AzywqVVOpCob62ZiY",
        notes: expect.stringContaining("orphaned purchase reconciled for biz-orphan-1")
      })
    );
  });

  it("disables auto-renew BEFORE pooling, and passes the claim guard", async () => {
    // Mirrors the scheduled sweep: pooling a still-renewing box means a
    // later failed adopt retires it with the subscription alive, invisible
    // to every posture check.
    const calls: string[] = [];
    const disableAutoRenew = vi.fn(async () => {
      calls.push("disable");
    });
    const release = vi.fn(async () => {
      calls.push("release");
      return "pooled" as const;
    });
    const args = makeArgs({
      listVirtualMachines: vi
        .fn()
        .mockResolvedValue([vm({ id: 1815606, subscription_id: "hsub-orphan" })]),
      disableAutoRenew,
      release
    });
    const result = await reconcileOrphanedPurchases(args);
    expect(result).toHaveLength(1);
    expect(calls).toEqual(["disable", "release"]);
    expect(disableAutoRenew).toHaveBeenCalledWith("hsub-orphan");
    // The snapshot race guard: a concurrently pooled-and-claimed row must
    // never be flipped back to available by this release.
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ skipIfClaimed: true }));
  });

  it("skips pooling when the auto-renew disable fails (daily sweep rescues it)", async () => {
    const release = vi.fn();
    const args = makeArgs({
      listVirtualMachines: vi
        .fn()
        .mockResolvedValue([vm({ id: 1815606, subscription_id: "hsub-orphan" })]),
      disableAutoRenew: vi.fn(async () => {
        throw new Error("hostinger 5xx");
      }),
      release
    });
    const result = await reconcileOrphanedPurchases(args);
    expect(result).toEqual([]);
    expect(release).not.toHaveBeenCalled();

    // Non-Error throw stringifies the same way.
    const release2 = vi.fn();
    const result2 = await reconcileOrphanedPurchases(
      makeArgs({
        listVirtualMachines: vi
          .fn()
          .mockResolvedValue([vm({ id: 1815607, subscription_id: "hsub-orphan-2" })]),
        disableAutoRenew: vi.fn(async () => {
          throw "string 5xx";
        }),
        release: release2
      })
    );
    expect(result2).toEqual([]);
    expect(release2).not.toHaveBeenCalled();
  });

  it("does NOT count a VM whose release was skipped as claimed elsewhere", async () => {
    // Bugbot on the first cut: a skipped release still pushed the VM onto
    // the reconciled list, so reconcileUntilSizeMatch treated an
    // already-claimed box as this attempt's size match and stopped waiting
    // for the real one.
    const release = vi.fn(async () => "skipped" as const);
    const args = makeArgs({
      listVirtualMachines: vi
        .fn()
        .mockResolvedValue([vm({ id: 1815606, subscription_id: "hsub-orphan" })]),
      release
    });
    const result = await reconcileOrphanedPurchases(args);
    expect(release).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("still pools without a disable when no billing id resolves (nothing to disable)", async () => {
    const disableAutoRenew = vi.fn();
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([vm({ id: 1815606 })]),
      disableAutoRenew
    });
    const result = await reconcileOrphanedPurchases(args);
    expect(result).toHaveLength(1);
    expect(disableAutoRenew).not.toHaveBeenCalled();
  });

  it("looks up billing id via listBillingSubscriptions when the VM omits subscription_id", async () => {
    const listBillingSubscriptions = vi.fn().mockResolvedValue([
      { id: "billing-from-list", resource_id: "1863856" }
    ]);
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([vm({ id: 1863856, subscription_id: undefined })]),
      listBillingSubscriptions
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(listBillingSubscriptions).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        vmId: 1863856,
        plan: "kvm2",
        hostingerBillingSubscriptionId: "billing-from-list",
        createdAtMs: NOW - 5 * 60 * 1000
      }
    ]);
    expect(args.release).toHaveBeenCalledWith(
      expect.objectContaining({ hostingerBillingSubscriptionId: "billing-from-list" })
    );
  });

  it("continues without billing linkage when the billing-list lookup throws", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([vm({ id: 1863856, subscription_id: undefined })]),
      listBillingSubscriptions: vi.fn().mockRejectedValue(new Error("list down"))
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(result).toEqual([
      {
        vmId: 1863856,
        plan: "kvm2",
        hostingerBillingSubscriptionId: null,
        createdAtMs: NOW - 5 * 60 * 1000
      }
    ]);
  });

  it("stringifies a non-Error billing-list rejection", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([vm({ id: 1863857, subscription_id: undefined })]),
      listBillingSubscriptions: vi.fn().mockRejectedValue("list string boom")
    });

    const result = await reconcileOrphanedPurchases(args);
    expect(result).toEqual([
      {
        vmId: 1863857,
        plan: "kvm2",
        hostingerBillingSubscriptionId: null,
        createdAtMs: NOW - 5 * 60 * 1000
      }
    ]);
  });

  it("skips the billing-list call when every candidate already has subscription_id", async () => {
    const listBillingSubscriptions = vi.fn();
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({ id: 1, subscription_id: "already" })
      ]),
      listBillingSubscriptions
    });

    await reconcileOrphanedPurchases(args);
    expect(listBillingSubscriptions).not.toHaveBeenCalled();
  });

  it("skips VMs already tracked in vps_inventory (any state, including retired)", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([vm({ id: 100 }), vm({ id: 200 })]),
      listInventory: vi.fn().mockResolvedValue([{ vm_id: 100 }])
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(result.map((r) => r.vmId)).toEqual([200]);
    expect(args.release).toHaveBeenCalledTimes(1);
  });

  it("skips running/installing VMs (may belong to a live tenant or in-flight provision)", async () => {
    // Bugbot High: a `running` box whose post-purchase pool bookkeeping
    // failed is a live tenant box, pooling it would let another signup
    // recreate it. Only the fail-but-charge signature (`initial`, no
    // template) is safe to reclaim.
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({ id: 210, state: "running" }),
        vm({ id: 211, state: "installing" }),
        vm({ id: 212, state: "initial" })
      ])
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(result.map((r) => r.vmId)).toEqual([212]);
    expect(args.release).toHaveBeenCalledTimes(1);
  });

  it("skips an initial VM that already has a template applied (setup ran, not fail-but-charge)", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({ id: 220, template: { id: 1121, name: "Ubuntu 24.04 with Docker" } })
      ])
    });

    expect(await reconcileOrphanedPurchases(args)).toEqual([]);
    expect(args.release).not.toHaveBeenCalled();
  });

  // 2026-08-28, KIN Integrated Child Health: the purchase SUCCEEDED, Hostinger
  // applied the setup payload, and only our reply parsing failed. VM 1936826
  // was therefore `running` with a template, which the never-set-up signature
  // refuses, so the box we had just paid for was invisible to its own
  // recovery. The hostname is what makes it safely identifiable: it is derived
  // from the business id, so no other business's purchase asks for it.
  it("pools a running, set-up VM wearing THIS business's own purchase hostname", async () => {
    const args = makeArgs({
      businessId: "a912aff5-dd87-49fb-ad6a-477acefb66c0",
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({
          id: 1936826,
          state: "running",
          hostname: "nc-a912aff5-dd8.newcoworker.com",
          template: { id: 1121, name: "Ubuntu 24.04 with Docker" },
          subscription_id: "Azyp34VTaWZDIBG8"
        })
      ])
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(result.map((r) => r.vmId)).toEqual([1936826]);
    expect(args.release).toHaveBeenCalledTimes(1);
    // Pin the literal hostname the live box wears, so a change to the
    // derivation cannot quietly stop matching real boxes.
    expect(defaultPurchaseHostname("a912aff5-dd87-49fb-ad6a-477acefb66c0")).toBe(
      "nc-a912aff5-dd8.newcoworker.com"
    );
  });

  it.each(["initial", "installing", "running"])(
    "pools our own set-up purchase hostname at state=%s",
    async (state) => {
      const args = makeArgs({
        listVirtualMachines: vi.fn().mockResolvedValue([
          vm({
            id: 1936826,
            state,
            hostname: defaultPurchaseHostname("biz-orphan-1"),
            template: { id: 1121, name: "Ubuntu 24.04 with Docker" }
          })
        ])
      });

      expect((await reconcileOrphanedPurchases(args)).map((r) => r.vmId)).toEqual([1936826]);
    }
  );

  it.each(["stopped", "suspended", "destroyed", "error"])(
    "leaves our purchase hostname alone at state=%s (leftover, not this purchase's box)",
    async (state) => {
      const args = makeArgs({
        listVirtualMachines: vi.fn().mockResolvedValue([
          vm({
            id: 1936826,
            state,
            hostname: defaultPurchaseHostname("biz-orphan-1"),
            template: { id: 1121, name: "Ubuntu 24.04 with Docker" }
          })
        ])
      });

      expect(await reconcileOrphanedPurchases(args)).toEqual([]);
      expect(args.release).not.toHaveBeenCalled();
    }
  );

  it("leaves a running, set-up VM wearing ANOTHER business's hostname alone", async () => {
    const args = makeArgs({
      businessId: "a912aff5-dd87-49fb-ad6a-477acefb66c0",
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({
          id: 1869876,
          state: "running",
          hostname: defaultPurchaseHostname("056034a7-e84c-444d-8d15-747eeb1fa899"),
          template: { id: 1121, name: "Ubuntu 24.04 with Docker" }
        })
      ])
    });

    expect(await reconcileOrphanedPurchases(args)).toEqual([]);
    expect(args.release).not.toHaveBeenCalled();
  });

  it("leaves a tracked VM alone even when it wears our purchase hostname", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({
          id: 1864812,
          state: "running",
          hostname: defaultPurchaseHostname("biz-orphan-1"),
          template: { id: 1121, name: "Ubuntu 24.04 with Docker" }
        })
      ]),
      listInventory: vi.fn().mockResolvedValue([{ vm_id: 1864812 }])
    });

    expect(await reconcileOrphanedPurchases(args)).toEqual([]);
    expect(args.release).not.toHaveBeenCalled();
  });

  it("skips VMs older than the recency window (legacy strays must never auto-pool)", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({ id: 300, created_at: new Date(NOW - ORPHAN_MAX_AGE_MS - 1000).toISOString() }),
        // Exactly at the boundary is still inside the window.
        vm({ id: 301, created_at: new Date(NOW - ORPHAN_MAX_AGE_MS).toISOString() })
      ])
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(result.map((r) => r.vmId)).toEqual([301]);
  });

  it("skips VMs with a missing or unparseable created_at", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({ id: 400, created_at: undefined }),
        vm({ id: 401, created_at: "not-a-date" })
      ])
    });

    expect(await reconcileOrphanedPurchases(args)).toEqual([]);
    expect(args.release).not.toHaveBeenCalled();
  });

  it("skips VMs with an unrecognized plan (can't size-match for adopt)", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([vm({ id: 500, plan: "Game Panel 1" })])
    });

    expect(await reconcileOrphanedPurchases(args)).toEqual([]);
    expect(args.release).not.toHaveBeenCalled();
  });

  it("passes a null subscription id through when Hostinger omits it", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([vm({ id: 600, subscription_id: undefined })])
    });

    await reconcileOrphanedPurchases(args);

    expect(args.release).toHaveBeenCalledWith(
      expect.objectContaining({ vmId: 600, hostingerBillingSubscriptionId: null })
    );
  });

  it("defaults the clock to Date.now() and hostname to null when Hostinger omits it", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({
          id: 800,
          hostname: undefined,
          created_at: new Date(Date.now() - 60_000).toISOString()
        })
      ]),
      now: undefined
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(result.map((r) => r.vmId)).toEqual([800]);
    expect(args.release).toHaveBeenCalledWith(
      expect.objectContaining({ vmId: 800, hostname: null })
    );
  });

  it("pools multiple orphans in one pass", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({ id: 700, plan: "KVM 1" }),
        vm({ id: 701, plan: "KVM 2" })
      ])
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(result.map((r) => ({ vmId: r.vmId, plan: r.plan }))).toEqual([
      { vmId: 700, plan: "kvm1" },
      { vmId: 701, plan: "kvm2" }
    ]);
    expect(args.release).toHaveBeenCalledTimes(2);
  });
});

describe("orphanMatchesPurchaseAttempt", () => {
  it("rejects an orphan created AFTER the attempt failed (the forward ceiling)", () => {
    // The retry loop scans for up to 5 minutes; without a ceiling, a
    // same-size fail-but-charge from a DIFFERENT concurrent attempt that
    // materializes later passes the floor and gets stolen.
    const orphan = { vmId: 1, plan: "kvm2" as const, createdAtMs: 10_000 };
    expect(orphanMatchesPurchaseAttempt(orphan, "kvm2", 0, 9_000)).toBe(false);
    expect(orphanMatchesPurchaseAttempt(orphan, "kvm2", 0, 10_000)).toBe(true);
    // Ceiling alone (no floor) still binds.
    expect(orphanMatchesPurchaseAttempt(orphan, "kvm2", undefined, 9_000)).toBe(false);
    // No timestamp on the orphan: bounded matching requires one.
    expect(
      orphanMatchesPurchaseAttempt({ vmId: 1, plan: "kvm2" }, "kvm2", undefined, 9_000)
    ).toBe(false);
  });


  it("matches any size when minCreatedAtMs is omitted", () => {
    expect(orphanMatchesPurchaseAttempt({ vmId: 1, plan: "kvm2" }, "kvm2")).toBe(true);
    expect(orphanMatchesPurchaseAttempt({ vmId: 1, plan: "kvm1" }, "kvm2")).toBe(false);
  });

  it("requires createdAtMs at/after the purchase stamp", () => {
    expect(
      orphanMatchesPurchaseAttempt({ vmId: 1, plan: "kvm2", createdAtMs: 50 }, "kvm2", 100)
    ).toBe(false);
    expect(
      orphanMatchesPurchaseAttempt({ vmId: 1, plan: "kvm2", createdAtMs: 100 }, "kvm2", 100)
    ).toBe(true);
    expect(orphanMatchesPurchaseAttempt({ vmId: 1, plan: "kvm2" }, "kvm2", 100)).toBe(false);
  });
});

describe("reconcileUntilSizeMatch", () => {
  it("returns immediately when the first scan finds a size match", async () => {
    const sleep = vi.fn();
    const reconcile = vi.fn().mockResolvedValue([{ vmId: 1, plan: "kvm2" }]);

    const result = await reconcileUntilSizeMatch({
      reconcile,
      vpsSize: "kvm2",
      sleep,
      now: () => 0
    });

    expect(result).toEqual([{ vmId: 1, plan: "kvm2" }]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  // The whole point of tolerating a throw: one bad scan used to abort the
  // loop, the caller rethrew the original purchase error, and the box we had
  // already paid for was abandoned. It materializes ~58s in, so a blip at
  // second 0 must not cost us the box.
  it("keeps polling through a transient scan failure and still finds the paid box", async () => {
    let t = 0;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      t += ms;
    });
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error("hostinger 503"))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ vmId: 1863856, plan: "kvm2" }]);

    const result = await reconcileUntilSizeMatch({
      reconcile,
      vpsSize: "kvm2",
      sleep,
      now: () => t,
      intervalMs: 30_000,
      budgetMs: 5 * 60_000
    });

    expect(result).toEqual([{ vmId: 1863856, plan: "kvm2" }]);
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  // Bounded, though: when the list API is simply down, spinning to the full
  // budget only delays the real purchase error reaching the operator.
  it("gives up after enough consecutive scan failures", async () => {
    let t = 0;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      t += ms;
    });
    const reconcile = vi.fn().mockRejectedValue(new Error("hostinger down"));

    const result = await reconcileUntilSizeMatch({
      reconcile,
      vpsSize: "kvm2",
      sleep,
      now: () => t,
      intervalMs: 30_000,
      budgetMs: 5 * 60_000
    });

    expect(result).toEqual([]);
    expect(reconcile).toHaveBeenCalledTimes(ORPHAN_RECONCILE_MAX_CONSECUTIVE_FAILURES);
    // Gave up well inside the 5-minute budget.
    expect(t).toBeLessThan(5 * 60_000);
  });

  // A failure that is followed by a success is not "consecutive", so a flaky
  // API that recovers keeps its full budget.
  it("resets the failure count after a successful scan", async () => {
    let t = 0;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      t += ms;
    });
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error("blip 1"))
      .mockRejectedValueOnce(new Error("blip 2"))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("blip 3"))
      .mockRejectedValueOnce(new Error("blip 4"))
      .mockResolvedValueOnce([{ vmId: 1863856, plan: "kvm2" }]);

    const result = await reconcileUntilSizeMatch({
      reconcile,
      vpsSize: "kvm2",
      sleep,
      now: () => t,
      intervalMs: 30_000,
      budgetMs: 10 * 60_000
    });

    expect(result).toEqual([{ vmId: 1863856, plan: "kvm2" }]);
    expect(reconcile).toHaveBeenCalledTimes(6);
  });

  it("retries until a size-matching orphan appears (Hostinger async materialization)", async () => {
    // Amy Laidlaw Jul 28 2026: first scan found nothing; VM appeared ~58s later.
    let t = 0;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      t += ms;
    });
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ vmId: 1863856, plan: "kvm2" }]);

    const result = await reconcileUntilSizeMatch({
      reconcile,
      vpsSize: "kvm2",
      sleep,
      now: () => t,
      intervalMs: 30_000,
      budgetMs: 5 * 60_000
    });

    expect(result).toEqual([{ vmId: 1863856, plan: "kvm2" }]);
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it("stops at the budget when no size match ever appears", async () => {
    let t = 0;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      t += ms;
    });
    const reconcile = vi.fn().mockResolvedValue([{ vmId: 9, plan: "kvm8" }]);

    const result = await reconcileUntilSizeMatch({
      reconcile,
      vpsSize: "kvm2",
      sleep,
      now: () => t,
      intervalMs: 30_000,
      budgetMs: 90_000
    });

    expect(result).toEqual([{ vmId: 9, plan: "kvm8" }]);
    expect(t).toBeGreaterThanOrEqual(90_000);
  });

  it("keeps earlier orphans across retries (dedupe by vmId)", async () => {
    let t = 0;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      t += ms;
    });
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce([{ vmId: 1, plan: "kvm1" }])
      .mockResolvedValueOnce([{ vmId: 2, plan: "kvm2" }]);

    const result = await reconcileUntilSizeMatch({
      reconcile,
      vpsSize: "kvm2",
      sleep,
      now: () => t,
      intervalMs: 1,
      budgetMs: 10_000
    });

    expect(result).toEqual([
      { vmId: 1, plan: "kvm1" },
      { vmId: 2, plan: "kvm2" }
    ]);
  });

  it("ignores same-size orphans older than minCreatedAtMs and keeps polling", async () => {
    let t = 1_000_000;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      t += ms;
    });
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce([{ vmId: 1, plan: "kvm2", createdAtMs: 100_000 }])
      .mockResolvedValueOnce([
        { vmId: 1, plan: "kvm2", createdAtMs: 100_000 },
        { vmId: 2, plan: "kvm2", createdAtMs: 1_000_000 }
      ]);

    const result = await reconcileUntilSizeMatch({
      reconcile,
      vpsSize: "kvm2",
      sleep,
      now: () => t,
      intervalMs: 1,
      budgetMs: 10_000,
      minCreatedAtMs: 940_000
    });

    expect(result.map((o) => o.vmId)).toEqual([1, 2]);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("exposes the production retry constants", () => {
    expect(ORPHAN_RECONCILE_RETRY_INTERVAL_MS).toBe(30_000);
    expect(ORPHAN_RECONCILE_RETRY_BUDGET_MS).toBe(5 * 60_000);
  });

  it("defaults now/interval/budget when omitted", async () => {
    const sleep = vi.fn();
    const reconcile = vi.fn().mockResolvedValue([{ vmId: 1, plan: "kvm2" }]);
    await reconcileUntilSizeMatch({ reconcile, vpsSize: "kvm2", sleep });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
