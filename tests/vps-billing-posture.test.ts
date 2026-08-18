import { describe, expect, it, vi } from "vitest";
import { checkVpsBillingPosture } from "@/lib/vps/billing-posture";
import type { BusinessRow } from "@/lib/db/businesses";
import type { VpsInventoryRow } from "@/lib/db/vps-inventory";

function biz(overrides: Partial<BusinessRow> & { id: string }): BusinessRow {
  return {
    name: `biz-${overrides.id}`,
    owner_email: `${overrides.id}@example.com`,
    tier: "standard",
    status: "online",
    hostinger_vps_id: "1815606",
    vps_provider: "hostinger",
    created_at: "2026-07-08T00:00:00Z",
    ...overrides
  } as BusinessRow;
}

function poolRow(overrides: Partial<VpsInventoryRow> & { vm_id: number }): VpsInventoryRow {
  return {
    hostname: `srv${overrides.vm_id}.hstgr.cloud`,
    plan: "kvm2",
    state: "available",
    hostinger_billing_subscription_id: "hsub-pool",
    assigned_business_id: null,
    acquired_at: "2026-07-01T00:00:00Z",
    assigned_at: null,
    notes: null,
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  } as VpsInventoryRow;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    listBusinesses: vi.fn().mockResolvedValue([]),
    // Default: every candidate business has a live (active/past_due)
    // STRIPE-BACKED NewCoworker subscription, so the auto-heal gate passes
    // unless a test narrows it.
    listBusinessIdsWithLiveSubscription: vi
      .fn()
      .mockImplementation(async (ids: string[]) => ({
        stripeBacked: new Set(ids),
        stripeless: new Set<string>(),
        cancelAtPeriodEnd: new Set<string>()
      })),
    listInventory: vi.fn().mockResolvedValue([]),
    getVirtualMachine: vi
      .fn()
      .mockResolvedValue({ id: 1815606, state: "running", subscription_id: "hsub-1" }),
    listVirtualMachines: vi.fn().mockResolvedValue([]),
    listBillingSubscriptions: vi.fn().mockResolvedValue([]),
    enableAutoRenewal: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe("checkVpsBillingPosture, tenant direction", () => {
  it("reports nothing when the tenant's box renews", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([biz({ id: "b1" })]),
      listBillingSubscriptions: vi
        .fn()
        .mockResolvedValue([{ id: "hsub-1", status: "active", is_auto_renewed: true }])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(result).toEqual({ checkedTenantVms: 1, checkedPoolBoxes: 0, findings: [] });
    expect(deps.enableAutoRenewal).not.toHaveBeenCalled();
  });

  it("auto-heals a live tenant whose subscription has auto-renew off", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([biz({ id: "b1" })]),
      listBillingSubscriptions: vi.fn().mockResolvedValue([
        { id: "hsub-1", status: "active", is_auto_renewed: false, expires_at: "2026-08-02T00:00:00Z" }
      ])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(deps.enableAutoRenewal).toHaveBeenCalledWith("hsub-1");
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: "tenant_auto_renew_off",
        vmId: 1815606,
        businessId: "b1",
        hostingerBillingSubscriptionId: "hsub-1",
        expiresAt: "2026-08-02T00:00:00Z",
        autoHealed: true,
        detail: expect.stringContaining("re-enabled by posture check")
      })
    ]);
  });

  it("auto-heals a non_renewing subscription (the srv1800985 production case)", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([biz({ id: "pilot", hostinger_vps_id: "1800985" })]),
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ id: 1800985, state: "running", subscription_id: "hsub-pilot" }),
      listBillingSubscriptions: vi.fn().mockResolvedValue([
        {
          id: "hsub-pilot",
          status: "non_renewing",
          is_auto_renewed: false,
          expires_at: null,
          next_billing_at: "2026-08-02T00:00:00Z"
        }
      ])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(deps.enableAutoRenewal).toHaveBeenCalledWith("hsub-pilot");
    // expires_at null falls back to next_billing_at.
    expect(result.findings[0]).toEqual(
      expect.objectContaining({ autoHealed: true, expiresAt: "2026-08-02T00:00:00Z" })
    );
  });

  it("reports (without healing) when the re-enable call fails, Error and non-Error", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([biz({ id: "b1" }), biz({ id: "b2", hostinger_vps_id: "222" })]),
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce({ id: 1815606, subscription_id: "hsub-1", state: "running" })
        .mockResolvedValueOnce({ id: 222, subscription_id: "hsub-2", state: "running" }),
      listBillingSubscriptions: vi.fn().mockResolvedValue([
        { id: "hsub-1", status: "active", is_auto_renewed: false },
        { id: "hsub-2", status: "active", is_auto_renewed: false }
      ]),
      enableAutoRenewal: vi
        .fn()
        .mockRejectedValueOnce(new Error("hostinger 500"))
        .mockRejectedValueOnce("string boom")
    });

    const result = await checkVpsBillingPosture(deps);

    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        autoHealed: false,
        detail: expect.stringContaining("re-enable FAILED (hostinger 500)")
      })
    );
    expect(result.findings[1]).toEqual(
      expect.objectContaining({
        autoHealed: false,
        detail: expect.stringContaining("re-enable FAILED (string boom)"),
        expiresAt: null
      })
    );
  });

  it("does not try to re-enable a cancelled subscription (nothing to renew)", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([biz({ id: "b1" })]),
      listBillingSubscriptions: vi
        .fn()
        .mockResolvedValue([{ id: "hsub-1", status: "cancelled", is_auto_renewed: false }])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(deps.enableAutoRenewal).not.toHaveBeenCalled();
    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        autoHealed: false,
        detail: expect.stringContaining("manual replacement")
      })
    );
  });

  it("reports an unreachable VM, Error and non-Error lookups", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([biz({ id: "b1" }), biz({ id: "b2", hostinger_vps_id: "222" })]),
      getVirtualMachine: vi
        .fn()
        .mockRejectedValueOnce(new Error("HTTP 404"))
        .mockRejectedValueOnce("vm string boom")
    });

    const result = await checkVpsBillingPosture(deps);

    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: "tenant_vm_unreachable",
        businessId: "b1",
        detail: expect.stringContaining("HTTP 404")
      }),
      expect.objectContaining({
        kind: "tenant_vm_unreachable",
        businessId: "b2",
        detail: expect.stringContaining("vm string boom")
      })
    ]);
  });

  it("reports when no billing subscription resolves for the VM", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([
        biz({ id: "no-sub-id" }),
        biz({ id: "unknown-sub", hostinger_vps_id: "333" })
      ]),
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce({ id: 1815606, state: "running" }) // no subscription_id at all
        .mockResolvedValueOnce({ id: 333, state: "running", subscription_id: "hsub-unknown" }),
      listBillingSubscriptions: vi.fn().mockResolvedValue([])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        kind: "tenant_auto_renew_off",
        hostingerBillingSubscriptionId: null,
        detail: expect.stringContaining("No billing subscription resolved")
      })
    );
    expect(result.findings[1]).toEqual(
      expect.objectContaining({ hostingerBillingSubscriptionId: "hsub-unknown" })
    );
  });

  it("reports (never heals) a Stripe-less live tenant, the Residency Pilot regression", async () => {
    // Jul 9 2026 production incident: the pilot's internal subscription is
    // status=active but has NO Stripe payment behind it, and its box was
    // deliberately parked non-renewing to lapse Aug 2. The first posture
    // run auto-healed it. The gate now requires a Stripe payment before
    // spending platform money; Stripe-less rows are surfaced report-only.
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([biz({ id: "pilot", hostinger_vps_id: "1800985" })]),
      listBusinessIdsWithLiveSubscription: vi
        .fn()
        .mockResolvedValue({
          stripeBacked: new Set(),
          stripeless: new Set(["pilot"]),
          cancelAtPeriodEnd: new Set()
        }),
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ id: 1800985, state: "running", subscription_id: "hsub-pilot" }),
      listBillingSubscriptions: vi.fn().mockResolvedValue([
        {
          id: "hsub-pilot",
          status: "non_renewing",
          is_auto_renewed: false,
          expires_at: "2026-08-02T20:54:21Z"
        }
      ])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(deps.enableAutoRenewal).not.toHaveBeenCalled();
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: "stripeless_tenant_auto_renew_off",
        vmId: 1800985,
        businessId: "pilot",
        autoHealed: false,
        expiresAt: "2026-08-02T20:54:21Z",
        detail: expect.stringContaining("no Stripe payment behind its active subscription")
      })
    ]);
  });

  it("Stripe-less report falls back to next_billing_at and then null for the period end", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([
        biz({ id: "p1", hostinger_vps_id: "101" }),
        biz({ id: "p2", hostinger_vps_id: "102" })
      ]),
      listBusinessIdsWithLiveSubscription: vi
        .fn()
        .mockResolvedValue({
          stripeBacked: new Set(),
          stripeless: new Set(["p1", "p2"]),
          cancelAtPeriodEnd: new Set()
        }),
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce({ id: 101, state: "running", subscription_id: "hsub-a" })
        .mockResolvedValueOnce({ id: 102, state: "running", subscription_id: "hsub-b" }),
      listBillingSubscriptions: vi.fn().mockResolvedValue([
        {
          id: "hsub-a",
          status: "non_renewing",
          is_auto_renewed: false,
          next_billing_at: "2026-08-15T00:00:00Z"
        },
        { id: "hsub-b", status: "non_renewing", is_auto_renewed: false }
      ])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(result.findings[0]).toEqual(
      expect.objectContaining({ vmId: 101, expiresAt: "2026-08-15T00:00:00Z" })
    );
    expect(result.findings[1]).toEqual(expect.objectContaining({ vmId: 102, expiresAt: null }));
  });

  it("skips the Stripe-less report when the box is renewing fine", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([biz({ id: "pilot" })]),
      listBusinessIdsWithLiveSubscription: vi
        .fn()
        .mockResolvedValue({
          stripeBacked: new Set(),
          stripeless: new Set(["pilot"]),
          cancelAtPeriodEnd: new Set()
        }),
      listBillingSubscriptions: vi
        .fn()
        .mockResolvedValue([{ id: "hsub-1", status: "active", is_auto_renewed: true }])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(result.findings).toEqual([]);
    expect(deps.enableAutoRenewal).not.toHaveBeenCalled();
  });

  it("never re-enables renewal for canceled-in-grace, pending, or subscription-less businesses", async () => {
    // Bugbot High: a canceled business still points at its VM until the
    // wipe, and the cancel lifecycle disabled that box's renewal ON
    // PURPOSE. Pending (never paid) and subscription-less (smoke/test)
    // rows are equally not "live tenants". None may be healed.
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([
        biz({ id: "grace" }),
        biz({ id: "pending", hostinger_vps_id: "222" }),
        biz({ id: "no-sub", hostinger_vps_id: "333" }),
        biz({ id: "live", hostinger_vps_id: "444" })
      ]),
      // Any-row live gate: only "live" has a Stripe-backed active/past_due
      // subscription (grace = canceled, pending = never paid, no-sub =
      // smoke row). The helper's any-row semantics also mean a paying
      // tenant with a newer pending resubscribe row still lands in this set.
      listBusinessIdsWithLiveSubscription: vi
        .fn()
        .mockResolvedValue({
          stripeBacked: new Set(["live"]),
          stripeless: new Set(),
          cancelAtPeriodEnd: new Set()
        }),
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ id: 444, state: "running", subscription_id: "hsub-live" }),
      listBillingSubscriptions: vi
        .fn()
        .mockResolvedValue([{ id: "hsub-live", status: "non_renewing", is_auto_renewed: false }])
    });

    const result = await checkVpsBillingPosture(deps);

    // Only the live (past_due counts — still a billing relationship) tenant
    // was checked and healed; the VM detail endpoint was never called for
    // the grace/pending/no-sub rows.
    expect(result.checkedTenantVms).toBe(1);
    expect(deps.getVirtualMachine).toHaveBeenCalledTimes(1);
    expect(deps.getVirtualMachine).toHaveBeenCalledWith(444);
    expect(deps.enableAutoRenewal).toHaveBeenCalledTimes(1);
    expect(deps.enableAutoRenewal).toHaveBeenCalledWith("hsub-live");
  });

  it("never re-enables renewal for cancel_at_period_end tenants", async () => {
    // Cancel-at-period-end disables Hostinger renewal on purpose so a
    // colliding Hostinger renewal date cannot charge before Stripe period
    // end. The tenant is still status=active (stripeBacked), but healing
    // would re-open the future-eating gap.
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([
        biz({ id: "leaving", hostinger_vps_id: "555" }),
        biz({ id: "live", hostinger_vps_id: "444" })
      ]),
      listBusinessIdsWithLiveSubscription: vi.fn().mockResolvedValue({
        stripeBacked: new Set(["leaving", "live"]),
        stripeless: new Set(),
        cancelAtPeriodEnd: new Set(["leaving"])
      }),
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ id: 444, state: "running", subscription_id: "hsub-live" }),
      listBillingSubscriptions: vi
        .fn()
        .mockResolvedValue([{ id: "hsub-live", status: "non_renewing", is_auto_renewed: false }])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(result.checkedTenantVms).toBe(1);
    expect(deps.getVirtualMachine).toHaveBeenCalledTimes(1);
    expect(deps.getVirtualMachine).toHaveBeenCalledWith(444);
    expect(deps.enableAutoRenewal).toHaveBeenCalledTimes(1);
    expect(deps.enableAutoRenewal).toHaveBeenCalledWith("hsub-live");
  });

  it("never heals a never_renew box, reports migration-needed instead (lapsing sub)", async () => {
    // srv1632631 case: KVM8 hardware pooled under the kvm2 label. A paying
    // tenant adopted it, but its $73.99/mo renewal must never be paid — the
    // cron nags ops to migrate the tenant, it does NOT re-enable renewal.
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([biz({ id: "b1", hostinger_vps_id: "1632631" })]),
      listInventory: vi
        .fn()
        .mockResolvedValue([
          poolRow({ vm_id: 1632631, state: "assigned", never_renew: true })
        ]),
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ id: 1632631, state: "running", subscription_id: "hsub-nr" }),
      listBillingSubscriptions: vi.fn().mockResolvedValue([
        {
          id: "hsub-nr",
          status: "non_renewing",
          is_auto_renewed: false,
          expires_at: "2026-07-30T00:00:00Z"
        }
      ])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(deps.enableAutoRenewal).not.toHaveBeenCalled();
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: "never_renew_tenant_migration_needed",
        vmId: 1632631,
        businessId: "b1",
        hostingerBillingSubscriptionId: "hsub-nr",
        expiresAt: "2026-07-30T00:00:00Z",
        autoHealed: false,
        detail: expect.stringContaining("migrate the tenant to its correct size")
      })
    ]);
  });

  it("reports a never_renew box whose renewal was flipped ON (manual hPanel or fail-open adopt)", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([
        biz({ id: "b1", hostinger_vps_id: "1632631" }),
        biz({ id: "b2", hostinger_vps_id: "103" })
      ]),
      listInventory: vi.fn().mockResolvedValue([
        poolRow({ vm_id: 1632631, state: "assigned", never_renew: true }),
        poolRow({ vm_id: 103, state: "assigned", never_renew: true })
      ]),
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce({ id: 1632631, state: "running", subscription_id: "hsub-nr" })
        .mockResolvedValueOnce({ id: 103, state: "running", subscription_id: "hsub-nodates" }),
      listBillingSubscriptions: vi.fn().mockResolvedValue([
        {
          id: "hsub-nr",
          status: "active",
          is_auto_renewed: true,
          next_billing_at: "2026-07-30T00:00:00Z"
        },
        // Hostinger omitting both period dates must not break the report.
        { id: "hsub-nodates", status: "active", is_auto_renewed: true }
      ])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(deps.enableAutoRenewal).not.toHaveBeenCalled();
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: "never_renew_tenant_migration_needed",
        vmId: 1632631,
        expiresAt: "2026-07-30T00:00:00Z",
        detail: expect.stringContaining("still auto-renewing, disable renewal in hPanel")
      }),
      expect.objectContaining({
        kind: "never_renew_tenant_migration_needed",
        vmId: 103,
        expiresAt: null,
        detail: expect.stringContaining("still auto-renewing, disable renewal in hPanel")
      })
    ]);
  });

  it("never_renew reporting works without a resolvable subscription, VM id fallback and null", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([
        biz({ id: "b1", hostinger_vps_id: "101" }),
        biz({ id: "b2", hostinger_vps_id: "102" })
      ]),
      listInventory: vi.fn().mockResolvedValue([
        poolRow({ vm_id: 101, state: "assigned", never_renew: true }),
        poolRow({ vm_id: 102, state: "assigned", never_renew: true })
      ]),
      getVirtualMachine: vi
        .fn()
        // subscription id present on the VM but missing from the list
        .mockResolvedValueOnce({ id: 101, state: "running", subscription_id: "hsub-ghost" })
        // no subscription id at all
        .mockResolvedValueOnce({ id: 102, state: "running" }),
      listBillingSubscriptions: vi.fn().mockResolvedValue([])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(deps.enableAutoRenewal).not.toHaveBeenCalled();
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: "never_renew_tenant_migration_needed",
        vmId: 101,
        hostingerBillingSubscriptionId: "hsub-ghost",
        expiresAt: null
      }),
      expect.objectContaining({
        kind: "never_renew_tenant_migration_needed",
        vmId: 102,
        hostingerBillingSubscriptionId: null,
        expiresAt: null
      })
    ]);
  });

  it("skips wiped businesses, non-Hostinger providers, and businesses without a numeric VM id", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([
        biz({ id: "wiped", status: "wiped" }),
        biz({ id: "byos", vps_provider: "byos", hostinger_vps_id: "byos-abc" }),
        biz({ id: "no-vm", hostinger_vps_id: null }),
        biz({ id: "bad-vm", hostinger_vps_id: "not-a-number" })
      ])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(result.checkedTenantVms).toBe(0);
    expect(deps.getVirtualMachine).not.toHaveBeenCalled();
    // None of them belong to the billing-posture directions.
    expect(
      result.findings.filter(
        (f) => f.kind !== "online_tenant_no_box" && f.kind !== "untracked_vm"
      )
    ).toEqual([]);
    // But `no-vm` and `bad-vm` ARE online Hostinger tenants pointing at no
    // usable box, which is the state direction 3 exists to surface. The wiped
    // and BYOS rows are correctly left alone.
    expect(
      result.findings.filter((f) => f.kind === "online_tenant_no_box").map((f) => f.businessId)
    ).toEqual(["no-vm", "bad-vm"]);
  });
});

describe("checkVpsBillingPosture, pool direction", () => {
  it("reports an available pool box that is still auto-renewing (report-only)", async () => {
    const deps = makeDeps({
      listInventory: vi.fn().mockResolvedValue([poolRow({ vm_id: 999 })]),
      listBillingSubscriptions: vi.fn().mockResolvedValue([
        {
          id: "hsub-pool",
          status: "active",
          is_auto_renewed: true,
          expires_at: null,
          next_billing_at: "2026-08-15T00:00:00Z"
        }
      ])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(result.checkedPoolBoxes).toBe(1);
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: "pool_box_auto_renew_on",
        vmId: 999,
        businessId: null,
        autoHealed: false,
        expiresAt: "2026-08-15T00:00:00Z",
        detail: expect.stringContaining("disable renewal in hPanel")
      })
    ]);
    expect(deps.enableAutoRenewal).not.toHaveBeenCalled();
  });

  it("prefers expires_at when present and reports null when Hostinger omits both dates", async () => {
    const deps = makeDeps({
      listInventory: vi.fn().mockResolvedValue([
        poolRow({ vm_id: 10, hostinger_billing_subscription_id: "hsub-a" }),
        poolRow({ vm_id: 11, hostinger_billing_subscription_id: "hsub-b" })
      ]),
      listBillingSubscriptions: vi.fn().mockResolvedValue([
        {
          id: "hsub-a",
          status: "active",
          is_auto_renewed: true,
          expires_at: "2026-09-01T00:00:00Z",
          next_billing_at: "2026-08-15T00:00:00Z"
        },
        { id: "hsub-b", status: "active", is_auto_renewed: true }
      ])
    });

    const result = await checkVpsBillingPosture(deps);

    expect(result.findings[0]).toEqual(
      expect.objectContaining({ vmId: 10, expiresAt: "2026-09-01T00:00:00Z" })
    );
    expect(result.findings[1]).toEqual(expect.objectContaining({ vmId: 11, expiresAt: null }));
  });

  it("skips pooled boxes that are parked correctly, unresolved, assigned, or retired", async () => {
    const deps = makeDeps({
      listInventory: vi.fn().mockResolvedValue([
        poolRow({ vm_id: 1, hostinger_billing_subscription_id: "hsub-off" }),
        poolRow({ vm_id: 2, hostinger_billing_subscription_id: null }),
        poolRow({ vm_id: 3, hostinger_billing_subscription_id: "hsub-missing" }),
        poolRow({ vm_id: 4, state: "assigned", hostinger_billing_subscription_id: "hsub-on" }),
        poolRow({ vm_id: 5, state: "retired", hostinger_billing_subscription_id: "hsub-on" })
      ]),
      listBillingSubscriptions: vi.fn().mockResolvedValue([
        { id: "hsub-off", status: "non_renewing", is_auto_renewed: false },
        { id: "hsub-on", status: "active", is_auto_renewed: true }
      ])
    });

    const result = await checkVpsBillingPosture(deps);

    // Only the 3 `available` rows are counted; none produce findings.
    expect(result.checkedPoolBoxes).toBe(3);
    expect(result.findings).toEqual([]);
  });
});

/**
 * Fleet consistency, as distinct from billing posture.
 *
 * V10: reconcileOrphanedPurchases only ever runs inline inside acquireVps, so
 * a paid fail-but-charge box that the inline pass missed (one transient
 * Hostinger 5xx aborts the loop) stays untracked forever, and the watchdog then
 * purchases again. vm 1806114 has sat untracked since 2026-07-05.
 *
 * V16: #1016 correctly stopped the hardware advisor escalating boxless
 * tenants, but nothing anywhere fires when a business is `online` with no
 * hostinger_vps_id at all, and a failed migration can produce exactly that.
 */
describe("checkVpsBillingPosture, fleet consistency", () => {
  it("flags a Hostinger VM that is absent from vps_inventory", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([]),
      listInventory: vi.fn().mockResolvedValue([]),
      listVirtualMachines: vi
        .fn()
        .mockResolvedValue([{ id: 1806114, state: "initial", plan: "KVM 1" }])
    });
    const res = await checkVpsBillingPosture(deps as never);
    const finding = res.findings.find((f) => f.kind === "untracked_vm");
    expect(finding).toBeDefined();
    expect(finding?.vmId).toBe(1806114);
  });

  it("does not flag a VM that vps_inventory already knows about", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([]),
      listInventory: vi
        .fn()
        .mockResolvedValue([{ vm_id: 1806114, plan: "kvm1", state: "available" }]),
      listVirtualMachines: vi
        .fn()
        .mockResolvedValue([{ id: 1806114, state: "initial", plan: "KVM 1" }])
    });
    const res = await checkVpsBillingPosture(deps as never);
    expect(res.findings.some((f) => f.kind === "untracked_vm")).toBe(false);
  });

  it("flags an online tenant with no box at all", async () => {
    const deps = makeDeps({
      listBusinesses: vi
        .fn()
        .mockResolvedValue([biz({ id: "b-nobox", hostinger_vps_id: null })]),
      listVirtualMachines: vi.fn().mockResolvedValue([])
    });
    const res = await checkVpsBillingPosture(deps as never);
    const finding = res.findings.find((f) => f.kind === "online_tenant_no_box");
    expect(finding).toBeDefined();
    expect(finding?.businessId).toBe("b-nobox");
    expect(finding?.detail).toContain("unset");
  });

  // The marketplace review sandboxes (Zoom, Meta, Google) are seeded status
  // "online" with NO subscription at all, purely so a reviewer can sign in and
  // see a dashboard. They have no tenant to serve and no box to lose, so they
  // were an ACTION REQUIRED line in every daily digest, forever.
  it("ignores an online business that has no subscription at all", async () => {
    const deps = makeDeps({
      listBusinesses: vi
        .fn()
        .mockResolvedValue([biz({ id: "sandbox-1", hostinger_vps_id: null })]),
      listVirtualMachines: vi.fn().mockResolvedValue([]),
      listBusinessIdsWithLiveSubscription: vi.fn().mockResolvedValue({
        stripeBacked: new Set<string>(),
        stripeless: new Set<string>(),
        cancelAtPeriodEnd: new Set<string>()
      })
    });
    const res = await checkVpsBillingPosture(deps as never);
    expect(res.findings.some((f) => f.kind === "online_tenant_no_box")).toBe(false);
  });

  // A tenant cancelling at period end is winding down, and the cancel planner
  // released its box on purpose. That is not a half-finished migration.
  it("ignores a boxless tenant that is cancelling at period end", async () => {
    const deps = makeDeps({
      listBusinesses: vi
        .fn()
        .mockResolvedValue([biz({ id: "truly", hostinger_vps_id: null })]),
      listVirtualMachines: vi.fn().mockResolvedValue([]),
      listBusinessIdsWithLiveSubscription: vi.fn().mockResolvedValue({
        stripeBacked: new Set(["truly"]),
        stripeless: new Set<string>(),
        cancelAtPeriodEnd: new Set(["truly"])
      })
    });
    const res = await checkVpsBillingPosture(deps as never);
    expect(res.findings.some((f) => f.kind === "online_tenant_no_box")).toBe(false);
  });

  // The liveness lookup used to cover only businesses that HELD a vm, which is
  // why a boxless one could never be filtered: it was not in the answer.
  it("asks about boxless businesses too when resolving live tenancy", async () => {
    const lookup = vi.fn().mockResolvedValue({
      stripeBacked: new Set(["b-nobox"]),
      stripeless: new Set<string>(),
      cancelAtPeriodEnd: new Set<string>()
    });
    const deps = makeDeps({
      listBusinesses: vi
        .fn()
        .mockResolvedValue([biz({ id: "b-nobox", hostinger_vps_id: null })]),
      listVirtualMachines: vi.fn().mockResolvedValue([]),
      listBusinessIdsWithLiveSubscription: lookup
    });
    await checkVpsBillingPosture(deps as never);
    expect(lookup).toHaveBeenCalledWith(["b-nobox"]);
  });

  it("still ignores a wiped business when resolving live tenancy", async () => {
    const lookup = vi.fn().mockResolvedValue({
      stripeBacked: new Set<string>(),
      stripeless: new Set<string>(),
      cancelAtPeriodEnd: new Set<string>()
    });
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([
        biz({ id: "alive", hostinger_vps_id: null }),
        biz({ id: "gone", hostinger_vps_id: null, status: "wiped" })
      ]),
      listVirtualMachines: vi.fn().mockResolvedValue([]),
      listBusinessIdsWithLiveSubscription: lookup
    });
    await checkVpsBillingPosture(deps as never);
    expect(lookup).toHaveBeenCalledWith(["alive"]);
  });

  // tenantVmId also rejects non-numeric and non-positive ids, so the message
  // must not claim the column is empty when ops can see a value in it.
  it("says an unusable VPS id is unusable, not missing", async () => {
    const deps = makeDeps({
      listBusinesses: vi
        .fn()
        .mockResolvedValue([biz({ id: "b-bad", hostinger_vps_id: "not-a-number" })]),
      listVirtualMachines: vi.fn().mockResolvedValue([])
    });
    const res = await checkVpsBillingPosture(deps as never);
    const finding = res.findings.find((f) => f.kind === "online_tenant_no_box");
    expect(finding?.detail).toContain("unusable value");
    expect(finding?.detail).toContain("not-a-number");
  });

  // Inventory drift: the box is missing from vps_inventory but a live
  // business still points at it. Telling ops to retire that would take the
  // tenant down.
  it("never tells ops to retire an untracked VM a live tenant still points at", async () => {
    const deps = makeDeps({
      listBusinesses: vi
        .fn()
        .mockResolvedValue([biz({ id: "b-live", hostinger_vps_id: "1806097" })]),
      listInventory: vi.fn().mockResolvedValue([]),
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ id: 1806097, state: "running", subscription_id: "hsub-live" }),
      listVirtualMachines: vi
        .fn()
        .mockResolvedValue([{ id: 1806097, state: "running", plan: "KVM 1" }])
    });
    const res = await checkVpsBillingPosture(deps as never);
    const finding = res.findings.find((f) => f.kind === "untracked_vm");
    expect(finding?.businessId).toBe("b-live");
    expect(finding?.detail).toContain("LIVE TENANT");
    expect(finding?.detail).toContain("Do NOT pool or retire");
    expect(finding?.detail).not.toContain("adopt into the pool");
  });

  it("does treat a VM no business points at as poolable or retirable", async () => {
    const deps = makeDeps({
      listBusinesses: vi
        .fn()
        .mockResolvedValue([biz({ id: "b-other", hostinger_vps_id: "1815606" })]),
      listInventory: vi.fn().mockResolvedValue([]),
      listVirtualMachines: vi
        .fn()
        .mockResolvedValue([{ id: 1806114, state: "initial", plan: "KVM 1" }])
    });
    const res = await checkVpsBillingPosture(deps as never);
    const finding = res.findings.find((f) => f.kind === "untracked_vm");
    expect(finding?.businessId).toBeNull();
    expect(finding?.detail).toContain("no business points at it");
  });

  it("carries the VM's plan and billing subscription onto the untracked finding", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([]),
      listInventory: vi.fn().mockResolvedValue([]),
      listVirtualMachines: vi.fn().mockResolvedValue([
        { id: 1900002, state: "running", plan: "KVM 2", subscription_id: "hsub-x" }
      ])
    });
    const res = await checkVpsBillingPosture(deps as never);
    const finding = res.findings.find((f) => f.kind === "untracked_vm");
    expect(finding?.hostingerBillingSubscriptionId).toBe("hsub-x");
    expect(finding?.detail).toContain("KVM 2");
  });

  // Hostinger being briefly unavailable must not lose the billing-posture
  // findings that were already collected.
  it("skips the untracked-VM check when Hostinger cannot be listed", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([]),
      listInventory: vi.fn().mockResolvedValue([]),
      listVirtualMachines: vi.fn().mockRejectedValue(new Error("hostinger 503"))
    });
    const res = await checkVpsBillingPosture(deps as never);
    expect(res.findings.some((f) => f.kind === "untracked_vm")).toBe(false);
  });

  it("tolerates a VM with no plan and a non-Error listing failure", async () => {
    const noPlan = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([]),
      listInventory: vi.fn().mockResolvedValue([]),
      listVirtualMachines: vi.fn().mockResolvedValue([{ id: 1900003, state: "initial" }])
    });
    const res = await checkVpsBillingPosture(noPlan as never);
    expect(res.findings.find((f) => f.kind === "untracked_vm")?.detail).toContain(
      "unknown plan"
    );

    const stringBoom = makeDeps({
      listBusinesses: vi.fn().mockResolvedValue([]),
      listInventory: vi.fn().mockResolvedValue([]),
      listVirtualMachines: vi.fn().mockRejectedValue("hostinger string boom")
    });
    const res2 = await checkVpsBillingPosture(stringBoom as never);
    expect(res2.findings.some((f) => f.kind === "untracked_vm")).toBe(false);
  });

  it("does not flag a wiped tenant with no box", async () => {
    const deps = makeDeps({
      listBusinesses: vi
        .fn()
        .mockResolvedValue([
          biz({ id: "b-wiped", hostinger_vps_id: null, status: "wiped" })
        ]),
      listVirtualMachines: vi.fn().mockResolvedValue([])
    });
    const res = await checkVpsBillingPosture(deps as never);
    expect(res.findings.some((f) => f.kind === "online_tenant_no_box")).toBe(false);
  });
});
