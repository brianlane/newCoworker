import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerWarnMock, loggerInfoMock, loggerErrorMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerErrorMock: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: loggerWarnMock,
    info: loggerInfoMock,
    error: loggerErrorMock,
    debug: vi.fn()
  }
}));

import {
  catalogFirstPeriodCents,
  renewalSavingsRatio,
  meetsRenewalSavingsThreshold,
  findCatalogFirstPeriodCents,
  isWithinRenewalWindow,
  isPartialTermCutover,
  runTermRenewalSweep,
  type TermRenewalSweepDeps
} from "@/lib/vps/term-renewal-sweep";
import type { BusinessRow } from "@/lib/db/businesses";
import type { SubscriptionRow } from "@/lib/db/subscriptions";
import type { CatalogItem } from "@/lib/hostinger/client";
import { HQ_BUSINESS_ID } from "@/lib/vps/shared-hardware";

const BIZ = "11111111-2222-3333-4444-555555555555";
const NOW = new Date("2026-07-20T12:00:00.000Z");

function biz(overrides: Partial<BusinessRow> & { id?: string } = {}): BusinessRow {
  return {
    id: BIZ,
    name: "Amy's Bakery",
    owner_email: "amy@example.com",
    tier: "standard",
    status: "online",
    hostinger_vps_id: "1800985",
    vps_provider: "hostinger",
    vps_size: "kvm2",
    data_residency_mode: "supabase",
    created_at: "2026-06-01T00:00:00.000Z",
    ...overrides
  } as BusinessRow;
}

function sub(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub-1",
    business_id: BIZ,
    status: "active",
    billing_period: "biennial",
    hostinger_billing_subscription_id: "hbs-old",
    ...overrides
  } as SubscriptionRow;
}

function catalogKvm2Biennial(firstPeriodCents: number, renewalLikePrice = 5000): CatalogItem[] {
  return [
    {
      id: "hostingercom-vps-kvm2",
      name: "KVM 2",
      category: "VPS",
      prices: [
        {
          id: "hostingercom-vps-kvm2-usd-2y",
          name: "2y",
          currency: "USD",
          price: renewalLikePrice,
          first_period_price: firstPeriodCents,
          period: 2,
          period_unit: "year"
        }
      ]
    }
  ];
}

function makeDeps(overrides: Partial<TermRenewalSweepDeps> = {}): TermRenewalSweepDeps {
  const nextBillingAt = "2026-08-01T00:00:00.000Z";
  return {
    listBusinesses: vi.fn(async () => [biz()]),
    listBusinessIdsWithLiveSubscription: vi.fn(async (ids: string[]) => ({
      stripeBacked: new Set(ids),
      stripeless: new Set<string>()
    })),
    listSubscriptionsByBusinessIds: vi.fn(async () => new Map([[BIZ, sub()]])),
    listCatalog: vi.fn(async () => catalogKvm2Biennial(3500, 5000)),
    listBillingSubscriptions: vi.fn(async () => [
      {
        id: "hbs-old",
        status: "active",
        renewal_price: 5000,
        next_billing_at: nextBillingAt
      }
    ]),
    hasActiveVpsMigrationLock: vi.fn(async () => false),
    tryClaimVpsMigration: vi.fn(async () => true),
    releaseVpsMigrationLock: vi.fn(async () => undefined),
    getBusiness: vi.fn(async () => biz()),
    getSubscription: vi.fn(async () => sub()),
    updateSubscription: vi.fn(async () => ({})),
    getActiveVpsSshKey: vi.fn(async () =>
      ({
        id: "key-1",
        private_key_pem: "PEM",
        public_key: "pub",
        ssh_username: "root"
      }) as never
    ),
    hostinger: {
      getVirtualMachine: vi.fn(async (id: number) => ({
        id,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }],
        subscription_id: "hbs-old"
      })),
      createSnapshot: vi.fn(async () => ({}) as never),
      stopVirtualMachine: vi.fn(async () => ({}) as never),
      listBillingSubscriptions: vi.fn(async () => [
        { id: "hbs-new", resource_id: "1900001" },
        { id: "hbs-old", resource_id: "1800985" }
      ] as never),
      disableBillingAutoRenewal: vi.fn(async () => ({}) as never)
    },
    backupBusinessData: vi.fn(async (_input, opts) => {
      await opts?.sshKeyLookup?.(BIZ);
      return {
        storagePath: "backups/biz.tgz",
        sizeBytes: 100,
        sha256: "abc"
      };
    }),
    restoreBusinessData: vi.fn(async () => ({})),
    orchestrateProvisioning: vi.fn(async () => ({
      vpsId: "1900001",
      hostingerBillingSubscriptionId: "hbs-new"
    })),
    releaseVpsToPool: vi.fn(async () => undefined),
    markVpsNeverRenew: vi.fn(async () => undefined),
    sendOpsEmail: vi.fn(async () => undefined),
    ...overrides
  };
}

describe("term-renewal sweep economics helpers", () => {
  it("catalogFirstPeriodCents prefers first_period_price", () => {
    expect(catalogFirstPeriodCents({ price: 5000, first_period_price: 3500 })).toBe(3500);
    expect(catalogFirstPeriodCents({ price: 5000 })).toBe(5000);
  });

  it("renewalSavingsRatio and meetsRenewalSavingsThreshold", () => {
    expect(renewalSavingsRatio(5000, 3500)).toBeCloseTo(0.3);
    expect(renewalSavingsRatio(0, 100)).toBe(0);
    expect(meetsRenewalSavingsThreshold(5000, 3500)).toBe(true);
    expect(meetsRenewalSavingsThreshold(5000, 4600)).toBe(false);
    expect(meetsRenewalSavingsThreshold(5000, 4500, 0.1)).toBe(true);
  });

  it("findCatalogFirstPeriodCents resolves by price item id", () => {
    expect(findCatalogFirstPeriodCents(catalogKvm2Biennial(3500), "kvm2", "biennial")).toBe(3500);
    expect(findCatalogFirstPeriodCents([], "kvm2", "biennial")).toBeNull();
  });

  it("findCatalogFirstPeriodCents skips catalog items without a matching price id", () => {
    const catalog: CatalogItem[] = [
      {
        id: "other",
        name: "Other",
        category: "VPS",
        prices: [{ id: "other-price", name: "x", currency: "USD", price: 100, period: 1, period_unit: "month" }]
      },
      ...catalogKvm2Biennial(3500)
    ];
    expect(findCatalogFirstPeriodCents(catalog, "kvm2", "biennial")).toBe(3500);
  });

  it("isWithinRenewalWindow respects the 30-day horizon", () => {
    expect(isWithinRenewalWindow("2026-08-01T00:00:00.000Z", NOW, 30)).toBe(true);
    expect(isWithinRenewalWindow("2026-06-01T00:00:00.000Z", NOW, 30)).toBe(false);
    expect(isWithinRenewalWindow("2026-09-01T00:00:00.000Z", NOW, 30)).toBe(false);
    expect(isWithinRenewalWindow("not-a-date", NOW, 30)).toBe(false);
  });
});

describe("runTermRenewalSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty when no stripe-backed candidates are in the renewal window", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(async () => [
        { id: "hbs-old", status: "active", renewal_price: 5000, next_billing_at: "2026-12-01T00:00:00.000Z" }
      ])
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result).toEqual({ checked: 0, skippedEconomics: 0, migrated: 0, findings: [] });
    expect(deps.orchestrateProvisioning).not.toHaveBeenCalled();
  });

  it("skips economics when savings are below threshold", async () => {
    const deps = makeDeps({
      listCatalog: vi.fn(async () => catalogKvm2Biennial(4800, 5000))
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(0);
    expect(result.skippedEconomics).toBe(1);
    expect(result.findings[0]).toEqual(
      expect.objectContaining({ kind: "skipped_economics", businessId: BIZ })
    );
    expect(deps.orchestrateProvisioning).not.toHaveBeenCalled();
  });

  it("migrates assigned never_renew boxes (they are the migration signal)", async () => {
    // never_renew on a live tenant box is why billing-posture nags; the sweep
    // must migrate them, not skip them.
    const result = await runTermRenewalSweep(makeDeps(), { now: NOW });
    expect(result.migrated).toBe(1);
  });

  it("skips when a migration lease is already held", async () => {
    const deps = makeDeps({
      hasActiveVpsMigrationLock: vi.fn(async () => true)
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.findings[0]?.kind).toBe("skipped_in_flight");
    expect(deps.tryClaimVpsMigration).not.toHaveBeenCalled();
  });

  it("skips shared-hardware and residency tenants", async () => {
    const sharedDeps = makeDeps({
      listBusinesses: vi.fn(async () => [biz({ id: HQ_BUSINESS_ID, hostinger_vps_id: "1800985" })]),
      listSubscriptionsByBusinessIds: vi.fn(
        async () => new Map([[HQ_BUSINESS_ID, sub({ business_id: HQ_BUSINESS_ID })]])
      )
    });
    const sharedResult = await runTermRenewalSweep(sharedDeps, { now: NOW });
    expect(sharedResult.findings[0]?.kind).toBe("skipped_guard");

    const residencyDeps = makeDeps({
      listBusinesses: vi.fn(async () => [biz({ data_residency_mode: "box" as never })])
    });
    const residencyResult = await runTermRenewalSweep(residencyDeps, { now: NOW });
    expect(residencyResult.findings[0]?.kind).toBe("skipped_guard");
  });

  it("skips partial cutovers where VM billing id disagrees with the subscription row", async () => {
    expect(
      isPartialTermCutover(
        { hostinger_billing_subscription_id: "old-billing" },
        { subscription_id: "new-billing" }
      )
    ).toBe(true);
    expect(
      isPartialTermCutover(
        { hostinger_billing_subscription_id: "same" },
        { subscription_id: "same" }
      )
    ).toBe(false);

    const deps = makeDeps({
      hostinger: {
        getVirtualMachine: vi.fn(async () => ({
          id: 1800985,
          subscription_id: "billing-on-new-vm",
          ipv4: [{ address: "1.2.3.4" }]
        })),
        listBillingSubscriptions: vi.fn(async () => []),
        createSnapshot: vi.fn(),
        stopVirtualMachine: vi.fn(),
        disableBillingAutoRenewal: vi.fn()
      } as never,
      listSubscriptionsByBusinessIds: vi.fn(
        async () =>
          new Map([
            [
              BIZ,
              sub({ hostinger_billing_subscription_id: "billing-still-on-old-row" })
            ]
          ])
      )
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.findings[0]?.kind).toBe("skipped_guard");
    expect(result.findings[0]?.detail).toMatch(/partial cutover/);
    expect(deps.tryClaimVpsMigration).not.toHaveBeenCalled();
  });

  it("migrates at most one tenant per run (soonest renewal first)", async () => {
    const biz2 = "22222222-2222-3333-4444-555555555555";
    const deps = makeDeps({
      listBusinesses: vi.fn(async () => [
        biz({ id: biz2, name: "Later", hostinger_vps_id: "1800999" }),
        biz({ id: BIZ, name: "Sooner", hostinger_vps_id: "1800985" })
      ]),
      listBusinessIdsWithLiveSubscription: vi.fn(async (ids: string[]) => ({
        stripeBacked: new Set(ids),
        stripeless: new Set<string>()
      })),
      listSubscriptionsByBusinessIds: vi.fn(
        async () =>
          new Map([
            [BIZ, sub()],
            [biz2, sub({ id: "sub-2", business_id: biz2, hostinger_billing_subscription_id: "hbs-2" })]
          ])
      ),
      listBillingSubscriptions: vi.fn(async () => [
        { id: "hbs-old", status: "active", renewal_price: 5000, next_billing_at: "2026-08-05T00:00:00.000Z" },
        { id: "hbs-2", status: "active", renewal_price: 5000, next_billing_at: "2026-08-15T00:00:00.000Z" }
      ]),
      hostinger: {
        getVirtualMachine: vi.fn(async (id: number) => ({
          id,
          state: "running",
          plan: "KVM 2",
          ipv4: [{ id: 1, address: "1.2.3.4" }],
          subscription_id: id === 1800985 ? "hbs-old" : "hbs-2"
        })),
        createSnapshot: vi.fn(async () => ({}) as never),
        stopVirtualMachine: vi.fn(async () => ({}) as never),
        listBillingSubscriptions: vi.fn(async () => [] as never),
        disableBillingAutoRenewal: vi.fn(async () => ({}) as never)
      }
    });

    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(1);
    expect(result.findings.filter((f) => f.kind === "migrated")).toHaveLength(1);
    expect(deps.orchestrateProvisioning).toHaveBeenCalledTimes(1);
    expect(deps.getBusiness).toHaveBeenCalledWith(BIZ);
  });

  it("happy path: backup, fresh purchase, restore, pool old box with never_renew", async () => {
    const deps = makeDeps();
    const result = await runTermRenewalSweep(deps, { now: NOW });

    expect(result.migrated).toBe(1);
    expect(deps.orchestrateProvisioning).toHaveBeenCalledWith({
      businessId: BIZ,
      tier: "standard",
      vpsSize: "kvm2",
      billingPeriod: "biennial",
      skipPoolAdopt: true,
      suppressOwnerNotify: true
    });
    expect(deps.updateSubscription).toHaveBeenCalledWith("sub-1", {
      hostinger_billing_subscription_id: "hbs-new"
    });
    expect(deps.hostinger.disableBillingAutoRenewal).toHaveBeenCalledWith("hbs-old");
    expect(deps.releaseVpsToPool).toHaveBeenCalledWith(
      expect.objectContaining({ vmId: 1800985, plan: "kvm2" })
    );
    expect(deps.markVpsNeverRenew).toHaveBeenCalledWith(1800985);
    expect(deps.sendOpsEmail).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "started", fromSize: "kvm2", toSize: "kvm2" })
    );
    expect(deps.sendOpsEmail).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "completed" })
    );
    expect(deps.releaseVpsMigrationLock).toHaveBeenCalledWith(BIZ);
  });

  it("backup failure leaves the old box renewing", async () => {
    const deps = makeDeps({
      backupBusinessData: vi.fn(async () => {
        throw new Error("ssh down");
      })
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(0);
    expect(result.findings[0]?.kind).toBe("migration_failed");
    expect(deps.orchestrateProvisioning).not.toHaveBeenCalled();
    expect(deps.hostinger.disableBillingAutoRenewal).not.toHaveBeenCalled();
    expect(deps.sendOpsEmail).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "failed", detail: expect.stringContaining("renew stays ON") })
    );
  });

  it("provision failure leaves the old box renewing", async () => {
    const deps = makeDeps({
      orchestrateProvisioning: vi.fn(async () => {
        throw new Error("purchase failed");
      })
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.findings[0]?.kind).toBe("migration_failed");
    expect(deps.hostinger.disableBillingAutoRenewal).not.toHaveBeenCalled();
  });

  it("restore failure leaves the old box renewing", async () => {
    const deps = makeDeps({
      restoreBusinessData: vi.fn(async () => {
        throw new Error("restore boom");
      })
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.findings[0]?.kind).toBe("migration_failed");
    expect(deps.hostinger.disableBillingAutoRenewal).not.toHaveBeenCalled();
  });

  it("billing repoint failure leaves the old box renewing", async () => {
    const deps = makeDeps({
      updateSubscription: vi.fn(async () => {
        throw new Error("db write failed");
      })
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.findings[0]?.kind).toBe("migration_failed");
    expect(deps.hostinger.disableBillingAutoRenewal).not.toHaveBeenCalled();
  });

  it("handles VM lookup failure during candidate scan", async () => {
    const deps = makeDeps({
      hostinger: {
        ...makeDeps().hostinger,
        getVirtualMachine: vi.fn(async () => {
          throw new Error("hostinger 404");
        })
      }
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.checked).toBe(0);
    expect(loggerWarnMock).toHaveBeenCalled();
  });

  it("falls back to expires_at when next_billing_at is missing", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(async () => [
        { id: "hbs-old", status: "active", renewal_price: 5000, expires_at: "2026-08-01T00:00:00.000Z" }
      ])
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.checked).toBe(1);
  });

  it("skips inactive subscriptions and missing catalog prices", async () => {
    const inactiveDeps = makeDeps({
      listSubscriptionsByBusinessIds: vi.fn(async () => new Map([[BIZ, sub({ status: "canceled" })]]))
    });
    expect((await runTermRenewalSweep(inactiveDeps, { now: NOW })).checked).toBe(0);

    const noCatalogDeps = makeDeps({
      listCatalog: vi.fn(async () => [])
    });
    const result = await runTermRenewalSweep(noCatalogDeps, { now: NOW });
    expect(result.skippedEconomics).toBe(1);
  });

  it("reports claim failure as skipped_in_flight", async () => {
    const deps = makeDeps({
      tryClaimVpsMigration: vi.fn(async () => false)
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.findings[0]?.kind).toBe("skipped_in_flight");
  });

  it("continues past economics failures to find the next eligible tenant", async () => {
    const biz2 = "22222222-2222-3333-4444-555555555555";
    const deps = makeDeps({
      listBusinesses: vi.fn(async () => [
        biz({ id: BIZ, hostinger_vps_id: "1800985" }),
        biz({ id: biz2, name: "Cheap renewal", hostinger_vps_id: "1800999" })
      ]),
      listSubscriptionsByBusinessIds: vi.fn(
        async () =>
          new Map([
            [BIZ, sub()],
            [biz2, sub({ id: "sub-2", business_id: biz2, hostinger_billing_subscription_id: "hbs-2" })]
          ])
      ),
      listBillingSubscriptions: vi.fn(async () => [
        { id: "hbs-old", status: "active", renewal_price: 5000, next_billing_at: "2026-08-01T00:00:00.000Z" },
        { id: "hbs-2", status: "active", renewal_price: 5000, next_billing_at: "2026-08-02T00:00:00.000Z" }
      ]),
      listCatalog: vi.fn(async () => catalogKvm2Biennial(4800, 5000)),
      hostinger: {
        ...makeDeps().hostinger,
        getVirtualMachine: vi.fn(async (id: number) => ({
          id,
          state: "running",
          plan: "KVM 2",
          ipv4: [{ id: 1, address: "1.2.3.4" }],
          subscription_id: id === 1800999 ? "hbs-2" : "hbs-old"
        }))
      }
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.skippedEconomics).toBe(2);
    expect(result.migrated).toBe(0);
  });

  it("handles missing old VM IP and SSH key as migration failures", async () => {
    const noIpDeps = makeDeps({
      hostinger: {
        ...makeDeps().hostinger,
        getVirtualMachine: vi.fn(async (id: number) => ({
          id,
          state: "running",
          plan: "KVM 2",
          ipv4: [],
          subscription_id: "hbs-old"
        }))
      }
    });
    expect((await runTermRenewalSweep(noIpDeps, { now: NOW })).findings[0]?.kind).toBe(
      "migration_failed"
    );

    const noKeyDeps = makeDeps({
      getActiveVpsSshKey: vi.fn(async () => null)
    });
    expect((await runTermRenewalSweep(noKeyDeps, { now: NOW })).findings[0]?.kind).toBe(
      "migration_failed"
    );
  });

  it("resolves billing ids via VM detail and list fallbacks during migration", async () => {
    const deps = makeDeps({
      getSubscription: vi.fn(async () => sub({ hostinger_billing_subscription_id: null })),
      orchestrateProvisioning: vi.fn(async () => ({
        vpsId: "1900001",
        hostingerBillingSubscriptionId: null
      })),
      hostinger: {
        getVirtualMachine: vi
          .fn()
          .mockResolvedValueOnce({
            id: 1800985,
            state: "running",
            plan: "KVM 2",
            ipv4: [{ id: 1, address: "1.2.3.4" }],
            subscription_id: "hbs-old"
          })
          .mockResolvedValueOnce({
            id: 1900001,
            state: "running",
            plan: "KVM 2",
            ipv4: [{ id: 2, address: "5.6.7.8" }],
            subscription_id: "hbs-new"
          })
          .mockResolvedValueOnce({
            id: 1800985,
            state: "stopped",
            plan: "KVM 2",
            ipv4: [{ id: 1, address: "1.2.3.4" }],
            subscription_id: "hbs-old"
          }),
        createSnapshot: vi.fn(async () => ({}) as never),
        stopVirtualMachine: vi.fn(async () => ({}) as never),
        listBillingSubscriptions: vi.fn(async () => [
          { id: "hbs-new", resource_id: "1900001" },
          { id: "hbs-old", resource_id: "1800985" }
        ] as never),
        disableBillingAutoRenewal: vi.fn(async () => ({}) as never)
      }
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(1);
  });

  it("fails the migration when pool return or never_renew marking fails", async () => {
    const poolFail = makeDeps({
      releaseVpsToPool: vi.fn(async () => {
        throw new Error("pool db down");
      })
    });
    const poolFailResult = await runTermRenewalSweep(poolFail, { now: NOW });
    expect(poolFailResult.migrated).toBe(0);
    expect(poolFailResult.findings[0]?.kind).toBe("migration_failed");
    expect(poolFail.sendOpsEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "failed",
        detail: expect.stringContaining("old-box bookkeeping failed")
      })
    );

    const neverRenewFail = makeDeps({
      markVpsNeverRenew: vi.fn(async () => {
        throw new Error("flag write failed");
      })
    });
    const neverRenewResult = await runTermRenewalSweep(neverRenewFail, { now: NOW });
    expect(neverRenewResult.migrated).toBe(0);
    expect(neverRenewResult.findings[0]?.kind).toBe("migration_failed");
  });

  it("completes with FOLLOW-UP when old billing disable fails but pool bookkeeping succeeds", async () => {
    const deps = makeDeps({
      hostinger: {
        ...makeDeps().hostinger,
        disableBillingAutoRenewal: vi.fn(async () => {
          throw new Error("hPanel says no");
        })
      }
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(1);
    expect(deps.sendOpsEmail).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "completed", detail: expect.stringContaining("FOLLOW-UP") })
    );
  });

  it("warns when lock release fails after migration", async () => {
    const deps = makeDeps({
      releaseVpsMigrationLock: vi.fn(async () => {
        throw new Error("release failed");
      })
    });
    await runTermRenewalSweep(deps, { now: NOW });
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "term-renewal sweep: migration lock release failed",
      expect.any(Object)
    );
  });

  it("skips non-hostinger providers during candidate scan", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn(async () => [biz({ vps_provider: "byos" as never, hostinger_vps_id: "99" })])
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.checked).toBe(0);
  });

  it("returns migration_failed when business disappears mid-migration", async () => {
    const deps = makeDeps({
      getBusiness: vi.fn(async () => null)
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.findings[0]?.kind).toBe("migration_failed");
  });

  it("handles new VM IP lookup failure after provision", async () => {
    const deps = makeDeps({
      hostinger: {
        ...makeDeps().hostinger,
        getVirtualMachine: vi
          .fn()
          .mockResolvedValueOnce({
            id: 1800985,
            state: "running",
            plan: "KVM 2",
            ipv4: [{ id: 1, address: "1.2.3.4" }],
            subscription_id: "hbs-old"
          })
          .mockRejectedValueOnce(new Error("new vm 404"))
      }
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.findings[0]?.kind).toBe("migration_failed");
    expect(deps.hostinger.disableBillingAutoRenewal).not.toHaveBeenCalled();
  });

  it("handles billing repoint when there is no active subscription row", async () => {
    const deps = makeDeps({
      getSubscription: vi.fn(async () => null)
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(1);
    expect(deps.updateSubscription).not.toHaveBeenCalled();
  });

  it("handles unknown old billing id at teardown", async () => {
    const deps = makeDeps({
      getSubscription: vi.fn(async () => sub({ hostinger_billing_subscription_id: null })),
      hostinger: {
        ...makeDeps().hostinger,
        getVirtualMachine: vi.fn(async (id: number) => ({
          id,
          state: "running",
          plan: "KVM 2",
          ipv4: [{ id: 1, address: "1.2.3.4" }]
        })),
        listBillingSubscriptions: vi.fn(async () => [])
      }
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(1);
    expect(deps.hostinger.disableBillingAutoRenewal).not.toHaveBeenCalled();
  });

  it("resolves billing sub from VM subscription_id when the row has no billing id", async () => {
    const deps = makeDeps({
      listSubscriptionsByBusinessIds: vi.fn(
        async () => new Map([[BIZ, sub({ hostinger_billing_subscription_id: null })]])
      )
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.checked).toBe(1);
  });

  it("skips subscriptions without a billing_period", async () => {
    const deps = makeDeps({
      listSubscriptionsByBusinessIds: vi.fn(
        async () => new Map([[BIZ, sub({ billing_period: null })]])
      )
    });
    expect((await runTermRenewalSweep(deps, { now: NOW })).checked).toBe(0);
  });

  it("skips when no billing subscription resolves for the VM", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(async () => []),
      hostinger: {
        ...makeDeps().hostinger,
        getVirtualMachine: vi.fn(async (id: number) => ({
          id,
          state: "running",
          plan: "KVM 2",
          ipv4: [{ id: 1, address: "1.2.3.4" }]
        }))
      }
    });
    expect((await runTermRenewalSweep(deps, { now: NOW })).checked).toBe(0);
  });

  it("fails migration guard for non-hostinger provider at migrate time", async () => {
    const deps = makeDeps({
      getBusiness: vi.fn(async () => biz({ vps_provider: "byos" as never }))
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.findings[0]?.kind).toBe("migration_failed");
    expect(result.findings[0]?.detail).toContain("Hostinger-only");
  });

  it("warns when snapshot or old billing list fallback fails", async () => {
    const snapshotDeps = makeDeps({
      hostinger: {
        ...makeDeps().hostinger,
        createSnapshot: vi.fn(async () => {
          throw new Error("snapshot denied");
        })
      }
    });
    expect((await runTermRenewalSweep(snapshotDeps, { now: NOW })).migrated).toBe(1);

    const billingListDeps = makeDeps({
      getSubscription: vi.fn(async () => sub({ hostinger_billing_subscription_id: null })),
      hostinger: {
        ...makeDeps().hostinger,
        getVirtualMachine: vi
          .fn()
          .mockResolvedValueOnce({
            id: 1800985,
            state: "running",
            plan: "KVM 2",
            ipv4: [{ id: 1, address: "1.2.3.4" }]
          })
          .mockResolvedValueOnce({
            id: 1900001,
            state: "running",
            plan: "KVM 2",
            ipv4: [{ id: 2, address: "5.6.7.8" }],
            subscription_id: "hbs-new"
          })
          .mockResolvedValueOnce({
            id: 1800985,
            state: "stopped",
            plan: "KVM 2",
            ipv4: [{ id: 1, address: "1.2.3.4" }]
          }),
        listBillingSubscriptions: vi.fn(async () => {
          throw new Error("billing list down");
        })
      }
    });
    expect((await runTermRenewalSweep(billingListDeps, { now: NOW })).migrated).toBe(1);
  });

  it("warns when old VM stop fails after successful cutover", async () => {
    const deps = makeDeps({
      hostinger: {
        ...makeDeps().hostinger,
        stopVirtualMachine: vi.fn(async () => {
          throw new Error("stop failed");
        })
      }
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(1);
    expect(deps.sendOpsEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "completed",
        detail: expect.stringContaining("stopped=false")
      })
    );
  });

  it("uses defaults and alternate billing price fields during the sweep", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(async () => [
        { id: "hbs-old", status: "active", total_price: 5000, next_billing_at: "2026-08-01T00:00:00.000Z" }
      ])
    });
    expect((await runTermRenewalSweep(deps)).migrated).toBe(1);
  });

  it("fails restore when the new VM has no public IP", async () => {
    const hostinger = makeDeps().hostinger;
    hostinger.getVirtualMachine = vi
      .fn()
      .mockResolvedValueOnce({
        id: 1800985,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }],
        subscription_id: "hbs-old"
      })
      .mockResolvedValueOnce({
        id: 1800985,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }],
        subscription_id: "hbs-old"
      })
      .mockResolvedValueOnce({
        id: 1900001,
        state: "running",
        plan: "KVM 2",
        ipv4: []
      });
    const deps = makeDeps({ hostinger });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.findings[0]?.kind).toBe("migration_failed");
    expect(deps.hostinger.disableBillingAutoRenewal).not.toHaveBeenCalled();
  });

  it("resolves new billing id from VM detail and billing list fallbacks", async () => {
    const hostinger = makeDeps().hostinger;
    hostinger.getVirtualMachine = vi
      .fn()
      .mockResolvedValueOnce({
        id: 1800985,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }],
        subscription_id: "hbs-old"
      })
      .mockResolvedValueOnce({
        id: 1800985,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }],
        subscription_id: "hbs-old"
      })
      .mockResolvedValueOnce({
        id: 1900001,
        state: "running",
        plan: "unknown-plan",
        ipv4: [{ id: 2, address: "5.6.7.8" }]
      })
      .mockResolvedValueOnce({
        id: 1900001,
        state: "running",
        plan: "unknown-plan",
        ipv4: [{ id: 2, address: "5.6.7.8" }],
        subscription_id: "hbs-from-vm"
      })
      .mockResolvedValueOnce({
        id: 1800985,
        state: "stopped",
        plan: "unknown-plan",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      });
    const deps = makeDeps({
      orchestrateProvisioning: vi.fn(async () => ({
        vpsId: "1900001",
        hostingerBillingSubscriptionId: null
      })),
      hostinger: {
        ...hostinger,
        listBillingSubscriptions: vi.fn(async () => [{ id: "hbs-from-list", resource_id: "1900001" }] as never)
      }
    });
    expect((await runTermRenewalSweep(deps, { now: NOW })).migrated).toBe(1);
    expect(deps.updateSubscription).toHaveBeenCalledWith("sub-1", {
      hostinger_billing_subscription_id: "hbs-from-vm"
    });
  });

  it("stringifies non-Error failures in backup and billing-list fallback paths", async () => {
    const backupDeps = makeDeps({
      backupBusinessData: vi.fn(async () => {
        throw "string backup boom";
      })
    });
    expect((await runTermRenewalSweep(backupDeps, { now: NOW })).findings[0]?.detail).toContain(
      "string backup boom"
    );

    const hostinger = makeDeps().hostinger;
    hostinger.getVirtualMachine = vi
      .fn()
      .mockResolvedValueOnce({
        id: 1800985,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }],
        subscription_id: "hbs-old"
      })
      .mockResolvedValueOnce({
        id: 1800985,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      })
      .mockResolvedValueOnce({
        id: 1900001,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 2, address: "5.6.7.8" }],
        subscription_id: "hbs-new"
      })
      .mockResolvedValueOnce({
        id: 1800985,
        state: "stopped",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      });
    const billingListDeps = makeDeps({
      getSubscription: vi.fn(async () => sub({ hostinger_billing_subscription_id: null })),
      hostinger: {
        ...hostinger,
        listBillingSubscriptions: vi.fn(async () => {
          throw "string list boom";
        })
      }
    });
    expect((await runTermRenewalSweep(billingListDeps, { now: NOW })).migrated).toBe(1);
  });

  it("ignores invalid hostinger_vps_id values during candidate scan", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn(async () => [biz({ hostinger_vps_id: "not-a-number" })])
    });
    expect((await runTermRenewalSweep(deps, { now: NOW })).checked).toBe(0);
  });

  it("skips when VM subscription_id does not map to a billing row", async () => {
    const deps = makeDeps({
      listSubscriptionsByBusinessIds: vi.fn(
        async () => new Map([[BIZ, sub({ hostinger_billing_subscription_id: null })]])
      ),
      hostinger: {
        ...makeDeps().hostinger,
        getVirtualMachine: vi.fn(async (id: number) => ({
          id,
          state: "running",
          plan: "KVM 2",
          ipv4: [{ id: 1, address: "1.2.3.4" }],
          subscription_id: "missing-billing-row"
        }))
      }
    });
    expect((await runTermRenewalSweep(deps, { now: NOW })).checked).toBe(0);
  });

  it("covers remaining billing-resolution and migration edge branches", async () => {
    const noDatesDeps = makeDeps({
      listBillingSubscriptions: vi.fn(async () => [
        { id: "hbs-old", status: "active", renewal_price: 5000, next_billing_at: null, expires_at: null }
      ])
    });
    expect((await runTermRenewalSweep(noDatesDeps, { now: NOW })).checked).toBe(0);

    const noPriceDeps = makeDeps({
      listBillingSubscriptions: vi.fn(async () => [
        { id: "hbs-old", status: "active", next_billing_at: "2026-08-01T00:00:00.000Z" }
      ])
    });
    expect((await runTermRenewalSweep(noPriceDeps, { now: NOW })).skippedEconomics).toBe(1);

    const defaultResidencyDeps = makeDeps({
      listBusinesses: vi.fn(async () => {
        const row = biz();
        delete (row as { data_residency_mode?: string }).data_residency_mode;
        return [row];
      })
    });
    expect((await runTermRenewalSweep(defaultResidencyDeps, { now: NOW })).migrated).toBe(1);

    const noVpsIdDeps = makeDeps({
      listBusinesses: vi.fn(async () => [
        {
          ...biz(),
          hostinger_vps_id: null,
          data_residency_mode: undefined
        } as BusinessRow
      ])
    });
    expect((await runTermRenewalSweep(noVpsIdDeps, { now: NOW })).checked).toBe(0);

    const hostinger = makeDeps().hostinger;
    hostinger.getVirtualMachine = vi
      .fn()
      .mockResolvedValueOnce({
        id: 1800985,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }],
        subscription_id: "hbs-old"
      })
      .mockResolvedValueOnce({
        id: 1800985,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      })
      .mockResolvedValueOnce({
        id: 1900001,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 2, address: "5.6.7.8" }]
      })
      .mockResolvedValueOnce({
        id: 1900001,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 2, address: "5.6.7.8" }]
      })
      .mockResolvedValueOnce({
        id: 1800985,
        state: "stopped",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      });
    const listFallbackDeps = makeDeps({
      getBusiness: vi.fn(async () => biz({ hostinger_vps_id: null })),
      getSubscription: vi.fn(async () => sub({ hostinger_billing_subscription_id: null })),
      backupBusinessData: vi.fn(async (_input, opts) => {
        await opts?.sshKeyLookup?.(BIZ);
        return { storagePath: "backups/biz.tgz", sizeBytes: 100, sha256: "abc" };
      }),
      orchestrateProvisioning: vi.fn(async () => ({
        vpsId: "1900001",
        hostingerBillingSubscriptionId: null
      })),
      hostinger: {
        ...hostinger,
        listBillingSubscriptions: vi.fn(async () => [])
      }
    });
    const listResult = await runTermRenewalSweep(listFallbackDeps, { now: NOW });
    expect(listResult.findings[0]?.kind).toBe("migration_failed");
    expect(listFallbackDeps.sendOpsEmail).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "started", detail: expect.stringContaining("Old box: none") })
    );

    const oldBillingFindHostinger = makeDeps().hostinger;
    oldBillingFindHostinger.getVirtualMachine = vi
      .fn()
      .mockResolvedValueOnce({
        id: 1800985,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }],
        subscription_id: "hbs-old"
      })
      .mockResolvedValueOnce({
        id: 1800985,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      })
      .mockResolvedValueOnce({
        id: 1900001,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 2, address: "5.6.7.8" }]
      })
      .mockResolvedValueOnce({
        id: 1900001,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 2, address: "5.6.7.8" }],
        subscription_id: "hbs-new"
      })
      .mockResolvedValueOnce({
        id: 1800985,
        state: "stopped",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      });
    const oldBillingFindDeps = makeDeps({
      getSubscription: vi.fn(async () => sub({ hostinger_billing_subscription_id: null })),
      hostinger: {
        ...oldBillingFindHostinger,
        listBillingSubscriptions: vi
          .fn()
          .mockResolvedValueOnce([{ id: "hbs-found-old", resource_id: "1800985" }])
          .mockResolvedValueOnce([{ id: "hbs-new", resource_id: "1900001" }])
      }
    });
    expect((await runTermRenewalSweep(oldBillingFindDeps, { now: NOW })).migrated).toBe(1);
    expect(oldBillingFindDeps.hostinger.disableBillingAutoRenewal).toHaveBeenCalledWith("hbs-found-old");

    const noNewBillingHostinger = makeDeps().hostinger;
    noNewBillingHostinger.getVirtualMachine = vi
      .fn()
      .mockResolvedValueOnce({
        id: 1800985,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }],
        subscription_id: "hbs-old"
      })
      .mockResolvedValueOnce({
        id: 1800985,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }],
        subscription_id: "hbs-old"
      })
      .mockResolvedValueOnce({
        id: 1900001,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 2, address: "5.6.7.8" }]
      })
      .mockResolvedValueOnce({
        id: 1900001,
        state: "running",
        plan: "KVM 2",
        ipv4: [{ id: 2, address: "5.6.7.8" }]
      })
      .mockResolvedValueOnce({
        id: 1800985,
        state: "stopped",
        plan: "KVM 2",
        ipv4: [{ id: 1, address: "1.2.3.4" }]
      });
    const noNewBillingDeps = makeDeps({
      orchestrateProvisioning: vi.fn(async () => ({
        vpsId: "1900001",
        hostingerBillingSubscriptionId: null
      })),
      hostinger: {
        ...noNewBillingHostinger,
        listBillingSubscriptions: vi.fn(async () => [{ id: "other-sub", resource_id: "9999999" }] as never)
      }
    });
    expect((await runTermRenewalSweep(noNewBillingDeps, { now: NOW })).findings[0]?.kind).toBe(
      "migration_failed"
    );
  });
});
