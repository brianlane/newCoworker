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
  isWithinPurchaseCooldown,
  isWithinRenewalWindow,
  latestPurchaseStamp,
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
  // 24 hours out, i.e. inside the 36-hour default window and on the run the
  // cron would actually catch a real box on.
  const nextBillingAt = "2026-07-21T12:00:00.000Z";
  return {
    listBusinesses: vi.fn(async () => [biz()]),
    listBusinessIdsWithLiveSubscription: vi.fn(async (ids: string[]) => ({
      stripeBacked: new Set(ids),
      stripeless: new Set<string>(),
      cancelAtPeriodEnd: new Set<string>()
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
    // No prior term purchase on record, so the cooldown never fires unless a
    // test opts into it.
    getLastTermPurchaseAt: vi.fn(async () => null),
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
    retireVpsSshKeysForVps: vi.fn(async () => 1),
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
    enqueueProvisioningJob: vi.fn(async () => undefined),
    runProvisioningJob: vi.fn(async (job, jobDeps) => {
      const tier =
        job.tier === "starter" || job.tier === "enterprise" ? job.tier : "standard";
      const out = await jobDeps.orchestrate({
        businessId: job.business_id,
        tier,
        vpsSize: (job.vps_size as "kvm1" | "kvm2" | "kvm4" | "kvm8" | null) ?? "kvm2",
        billingPeriod:
          job.billing_period === "monthly" ||
          job.billing_period === "annual" ||
          job.billing_period === "biennial"
            ? job.billing_period
            : null,
        skipPoolAdopt: job.skip_pool_adopt === true ? true : undefined,
        suppressOwnerNotify: job.suppress_owner_notify === true ? true : undefined
      });
      // Mirrors the real runProvisioningJob, which returns the orchestrate
      // result unchanged. Dropping deploySucceeded here would hide the very
      // case the cutover guard exists for.
      return {
        hostingerBillingSubscriptionId: out.hostingerBillingSubscriptionId,
        vpsId: out.vpsId ?? "1900001",
        deploySucceeded: out.deploySucceeded
      };
    }),
    markProvisioningJobOutcome: vi.fn(async () => undefined),
    releaseVpsToPool: vi.fn(async () => "pooled" as const),
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

  it("isWithinRenewalWindow respects an explicit horizon", () => {
    expect(isWithinRenewalWindow("2026-07-21T12:00:00.000Z", NOW, 30)).toBe(true);
    expect(isWithinRenewalWindow("2026-06-01T00:00:00.000Z", NOW, 30)).toBe(false);
    expect(isWithinRenewalWindow("2026-07-21T20:00:00.000Z", NOW, 30)).toBe(false);
    expect(isWithinRenewalWindow("not-a-date", NOW, 30)).toBe(false);
  });

  // The default is what the cron actually runs with, so pin it directly: a
  // freshly bought monthly box (~30 days out) must be out of range.
  it("isWithinRenewalWindow defaults to a 36-hour horizon", () => {
    expect(isWithinRenewalWindow("2026-07-21T00:00:00.000Z", NOW)).toBe(true);
    expect(isWithinRenewalWindow("2026-07-22T00:00:00.000Z", NOW)).toBe(true);
    expect(isWithinRenewalWindow("2026-07-22T00:00:01.000Z", NOW)).toBe(false);
    expect(isWithinRenewalWindow("2026-08-18T12:00:00.000Z", NOW)).toBe(false);
  });

  // The reason the window is 36 hours and not 24. The sweep runs `0 11 * * *`,
  // and every box it buys is bought BY that cron, so the box's renewal
  // anniversary is pinned about a minute AFTER the cron fires: KYP's real
  // next_billing_at is 11:01:08Z. At a 24h window the run one day earlier
  // lands just outside and the only qualifying run is 68 seconds before the
  // charge, which cannot finish a 10-30 minute migration. 36 hours catches it
  // a full day out.
  it("catches a box whose renewal is pinned just past the 24-hour mark", () => {
    const cronFireTime = new Date("2026-08-30T11:00:00.000Z");
    const renewalOneDayLater = "2026-08-31T11:01:08.000Z";
    expect(isWithinRenewalWindow(renewalOneDayLater, cronFireTime, 24)).toBe(false);
    expect(isWithinRenewalWindow(renewalOneDayLater, cronFireTime)).toBe(true);
  });

  it("isWithinPurchaseCooldown gates on how long ago the last box was bought", () => {
    expect(isWithinPurchaseCooldown(new Date("2026-07-18T12:00:00.000Z"), NOW)).toBe(true);
    expect(isWithinPurchaseCooldown(new Date("2026-07-13T12:00:00.000Z"), NOW)).toBe(true);
    expect(isWithinPurchaseCooldown(new Date("2026-07-13T11:00:00.000Z"), NOW)).toBe(false);
    expect(isWithinPurchaseCooldown(new Date("2026-07-19T12:00:00.000Z"), NOW, 12)).toBe(false);
  });

  // No record of a purchase must never read as "cooled down", or a first
  // migration could never start.
  it("isWithinPurchaseCooldown treats no known purchase as not cooled down", () => {
    expect(isWithinPurchaseCooldown(null, NOW)).toBe(false);
  });

  // A stamp in the future is a clock disagreement between us and Hostinger,
  // not permission to buy. Fail closed.
  it("isWithinPurchaseCooldown fails closed on a future stamp", () => {
    expect(isWithinPurchaseCooldown(new Date("2026-07-21T12:00:00.000Z"), NOW)).toBe(true);
  });

  // The cooldown reads two stamps because each can go missing on its own: the
  // provisioning_jobs row is overwritten by a later enqueue of a different
  // purpose, and the vps_inventory write is best-effort after the purchase
  // returns. One surviving stamp has to be enough.
  it("latestPurchaseStamp takes whichever stamp survived, or the later of both", () => {
    const older = new Date("2026-07-18T11:00:00.000Z");
    const newer = new Date("2026-07-19T11:00:00.000Z");
    expect(latestPurchaseStamp(older, newer)).toEqual(newer);
    expect(latestPurchaseStamp(newer, older)).toEqual(newer);
    expect(latestPurchaseStamp(null, older)).toEqual(older);
    expect(latestPurchaseStamp(older, null)).toEqual(older);
    expect(latestPurchaseStamp(null, null)).toBeNull();
    expect(latestPurchaseStamp(older, older)).toEqual(older);
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

  // A monthly Hostinger box is never more than ~30 days from its next bill, so
  // a 30-day window re-qualified a box the sweep had just bought. Observed in
  // production: KYP was migrated 2026-07-29 11:01 UTC, Scar Fairy 2026-07-30,
  // and KYP again 2026-07-31, one purchase per daily run. The window is the
  // first of two gates: migrate only when the renewal is actually imminent.
  // The second is the purchase cooldown below, which covers the case the
  // window cannot see, a purchase that happened and then failed to cut over.
  it("leaves a box 29 days from renewal alone", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(async () => [
        {
          id: "hbs-old",
          status: "active",
          renewal_price: 5000,
          next_billing_at: "2026-08-18T12:00:00.000Z"
        }
      ])
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result).toEqual({ checked: 0, skippedEconomics: 0, migrated: 0, findings: [] });
    expect(deps.orchestrateProvisioning).not.toHaveBeenCalled();
  });

  // The hole the window cannot close. A run buys a box and then fails before
  // orchestrate repoints businesses.hostinger_vps_id, so nothing the sweep
  // reads has changed: same old box, same renewal date, still inside the
  // window. #1041 made this concrete by refusing cutover on a failed deploy
  // and leaving the paid box behind. Without a cooldown the next daily run
  // buys another, and skipPoolAdopt means it will not reuse the paid one.
  it("does not buy again for a tenant we bought a box for two days ago", async () => {
    const deps = makeDeps({
      getLastTermPurchaseAt: vi.fn(async () => new Date("2026-07-18T11:00:00.000Z"))
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(0);
    expect(deps.orchestrateProvisioning).not.toHaveBeenCalled();
    // Checked before the lease claim, so a cooled-down tenant does not burn it.
    expect(deps.tryClaimVpsMigration).not.toHaveBeenCalled();
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: "skipped_cooldown",
        businessId: BIZ,
        detail: expect.stringContaining("2026-07-18T11:00:00.000Z")
      })
    ]);
  });

  it("buys again once the purchase cooldown has elapsed", async () => {
    const deps = makeDeps({
      getLastTermPurchaseAt: vi.fn(async () => new Date("2026-07-12T11:00:00.000Z"))
    });
    expect((await runTermRenewalSweep(deps, { now: NOW })).migrated).toBe(1);
  });

  it("honours an explicit purchase cooldown horizon", async () => {
    const deps = makeDeps({
      getLastTermPurchaseAt: vi.fn(async () => new Date("2026-07-18T11:00:00.000Z"))
    });
    const result = await runTermRenewalSweep(deps, { now: NOW, purchaseCooldownHours: 12 });
    expect(result.migrated).toBe(1);
  });

  // #999 disabled Hostinger auto-renew for these tenants on purpose so the box
  // lapses. Buying them a fresh term box undoes that and leaves the new box
  // renewing.
  it("skips a tenant whose subscription is already cancelling at period end", async () => {
    const deps = makeDeps({
      listBusinessIdsWithLiveSubscription: vi.fn(async (ids: string[]) => ({
        stripeBacked: new Set(ids),
        stripeless: new Set<string>(),
        cancelAtPeriodEnd: new Set(ids)
      }))
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(0);
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
    const deps = makeDeps();
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(1);
    expect(deps.markProvisioningJobOutcome).toHaveBeenCalledWith(BIZ, "succeeded");
  });

  it("still counts a migration when the post-cutover ledger mark throws", async () => {
    const deps = makeDeps({
      markProvisioningJobOutcome: vi.fn(async () => {
        throw "ledger string fail";
      })
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(1);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("markProvisioningJobOutcome"),
      expect.objectContaining({ error: "ledger string fail" })
    );

    const deps2 = makeDeps({
      markProvisioningJobOutcome: vi.fn(async () => {
        throw new Error("ledger down");
      })
    });
    const result2 = await runTermRenewalSweep(deps2, { now: NOW });
    expect(result2.migrated).toBe(1);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("markProvisioningJobOutcome"),
      expect.objectContaining({ error: "ledger down" })
    );
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
        stripeless: new Set<string>(),
        cancelAtPeriodEnd: new Set<string>()
      })),
      listSubscriptionsByBusinessIds: vi.fn(
        async () =>
          new Map([
            [BIZ, sub()],
            [biz2, sub({ id: "sub-2", business_id: biz2, hostinger_billing_subscription_id: "hbs-2" })]
          ])
      ),
      listBillingSubscriptions: vi.fn(async () => [
        { id: "hbs-old", status: "active", renewal_price: 5000, next_billing_at: "2026-07-21T00:00:00.000Z" },
        { id: "hbs-2", status: "active", renewal_price: 5000, next_billing_at: "2026-07-21T18:00:00.000Z" }
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
      suppressOwnerNotify: true,
      // Derived from the wall clock (route budget minus time already spent),
      // so pin the shape, not the value. remainingDeployDeadlineMs is covered
      // exactly in tests/provisioning-deploy-budget.test.ts.
      deployBudgetStartedAtMs: expect.any(Number)
    });
    expect(deps.updateSubscription).toHaveBeenCalledWith("sub-1", {
      hostinger_billing_subscription_id: "hbs-new"
    });
    expect(deps.hostinger.disableBillingAutoRenewal).toHaveBeenCalledWith("hbs-old");
    // expires_at has to be stamped at pool time, not left for the daily
    // billing-posture cron to backfill: claimAvailableVps treats a null
    // expiry as "unknown runway" and will hand the box to a new signup, so a
    // box pooled and claimed on the same day skips the 72h runway floor
    // entirely. The sweep already knows the old box's paid-through.
    expect(deps.releaseVpsToPool).toHaveBeenCalledWith(
      expect.objectContaining({
        vmId: 1800985,
        plan: "kvm2",
        expiresAt: "2026-07-21T12:00:00.000Z"
      })
    );
    expect(deps.markVpsNeverRenew).toHaveBeenCalledWith(1800985);
    // The old box's key row is retired at cutover, so fleet sweeps stop
    // SSHing into it and the pooled box carries no active key for its
    // previous tenant. This sweep is what stranded Scar Fairy's rows.
    expect(deps.retireVpsSshKeysForVps).toHaveBeenCalledWith("1800985");
    expect(deps.sendOpsEmail).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "started", fromSize: "kvm2", toSize: "kvm2" })
    );
    expect(deps.sendOpsEmail).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "completed" })
    );
    expect(deps.releaseVpsMigrationLock).toHaveBeenCalledWith(BIZ);
  });

  // The pooled row's expires_at means paid-through, so it must follow
  // paidThroughFromBillingSub (expires_at first). nextBillingTimestamp has the
  // opposite precedence, and using it would record a LATER date than the box
  // actually has, weakening the 72h runway floor this stamping feeds.
  it("pools with the paid-through, not the next-billing date, when they differ", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(async () => [
        {
          id: "hbs-old",
          status: "active",
          renewal_price: 5000,
          next_billing_at: "2026-07-21T12:00:00.000Z",
          expires_at: "2026-07-20T18:00:00.000Z"
        }
      ])
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(1);
    expect(deps.releaseVpsToPool).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: "2026-07-20T18:00:00.000Z" })
    );
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

  // orchestrateProvisioning records deploy_failed, leaves deploySucceeded
  // false, and then STILL marks the business online and returns a normal
  // result. Without a success flag on that result the cutover cannot tell, so
  // it restored onto a box with no working stack and then stopped and
  // never-renewed the healthy old one. #1014's 28-minute deploy deadline turns
  // slow-but-healthy deploys into this case, so it is not rare.
  it("deploy failure leaves the old box running and renewing", async () => {
    const deps = makeDeps({
      orchestrateProvisioning: vi.fn(async () => ({
        vpsId: "1900001",
        hostingerBillingSubscriptionId: "hbs-new",
        deploySucceeded: false
      }))
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.findings[0]?.kind).toBe("migration_failed");
    expect(result.migrated).toBe(0);
    // The whole point: the old box must survive untouched.
    expect(deps.hostinger.stopVirtualMachine).not.toHaveBeenCalled();
    expect(deps.hostinger.disableBillingAutoRenewal).not.toHaveBeenCalled();
    expect(deps.restoreBusinessData).not.toHaveBeenCalled();
  });

  it("provision failure leaves the old box renewing", async () => {
    const deps = makeDeps({
      orchestrateProvisioning: vi.fn(async () => {
        throw new Error("purchase failed");
      }),
      tryRecoverDeployCompleteNewBox: vi.fn(async () => null)
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.findings[0]?.kind).toBe("migration_failed");
    expect(deps.hostinger.disableBillingAutoRenewal).not.toHaveBeenCalled();
    expect(deps.markProvisioningJobOutcome).toHaveBeenCalledWith(
      BIZ,
      "failed",
      expect.stringContaining("purchase failed")
    );
  });

  it("continues cutover when provision throws but new box is deploy-complete", async () => {
    const deps = makeDeps({
      orchestrateProvisioning: vi.fn(async () => {
        throw new Error("vercel killed mid-deploy");
      }),
      tryRecoverDeployCompleteNewBox: vi.fn(async (_input, probeDeps) => {
        await probeDeps.getVirtualMachine?.(1900001);
        return {
          vpsId: "1900001",
          hostingerBillingSubscriptionId: "hbs-new"
        };
      })
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(1);
    expect(deps.restoreBusinessData).toHaveBeenCalled();
    expect(deps.hostinger.disableBillingAutoRenewal).toHaveBeenCalledWith("hbs-old");
    expect(deps.sendOpsEmail).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "completed" })
    );
  });

  it("fails when provision returns no vpsId and recovery finds nothing", async () => {
    const deps = makeDeps({
      runProvisioningJob: vi.fn(async () => ({
        hostingerBillingSubscriptionId: "hbs-new",
        vpsId: ""
      })),
      tryRecoverDeployCompleteNewBox: vi.fn(async () => null)
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
    expect(deps.markProvisioningJobOutcome).toHaveBeenCalledWith(
      BIZ,
      "failed",
      expect.stringContaining("restore boom")
    );
  });

  it("still records migration_failed when the failed-ledger mark throws", async () => {
    const deps = makeDeps({
      restoreBusinessData: vi.fn(async () => {
        throw new Error("restore boom");
      }),
      markProvisioningJobOutcome: vi.fn(async () => {
        throw new Error("ledger down");
      })
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.findings[0]?.kind).toBe("migration_failed");
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("markProvisioningJobOutcome(failed)"),
      expect.objectContaining({ error: "ledger down" })
    );

    const deps2 = makeDeps({
      restoreBusinessData: vi.fn(async () => {
        throw "restore string";
      }),
      markProvisioningJobOutcome: vi.fn(async () => {
        throw "ledger string";
      })
    });
    const result2 = await runTermRenewalSweep(deps2, { now: NOW });
    expect(result2.findings[0]?.kind).toBe("migration_failed");
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("markProvisioningJobOutcome(failed)"),
      expect.objectContaining({ error: "ledger string" })
    );
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
    expect(deps.markProvisioningJobOutcome).toHaveBeenCalledWith(
      BIZ,
      "failed",
      expect.stringContaining("billing repoint failed")
    );
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
        { id: "hbs-old", status: "active", renewal_price: 5000, expires_at: "2026-07-21T00:00:00.000Z" }
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
        { id: "hbs-old", status: "active", renewal_price: 5000, next_billing_at: "2026-07-21T00:00:00.000Z" },
        { id: "hbs-2", status: "active", renewal_price: 5000, next_billing_at: "2026-07-21T18:00:00.000Z" }
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

  it("completes the migration when retiring the old key row fails", async () => {
    // Deliberately asymmetric with the pool/never_renew failures below: those
    // leave the old box renewing untracked (real money), while a stale key
    // row is bookkeeping noise that the one-shot can mop up later.
    const deps = makeDeps({
      retireVpsSshKeysForVps: vi.fn(async () => {
        throw new Error("postgrest down");
      })
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(1);
    expect(result.findings[0]?.kind).toBe("migrated");
    expect(deps.releaseVpsToPool).toHaveBeenCalled();
  });

  it("retires the old key row before the box is returned to the pool", async () => {
    // A pooled box must not carry an active key belonging to its previous
    // tenant: adoptVpsForBusiness reuses whatever active row it finds.
    const order: string[] = [];
    const deps = makeDeps();
    (deps.retireVpsSshKeysForVps as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("retire");
      return 1;
    });
    (deps.releaseVpsToPool as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("pool");
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.migrated).toBe(1);
    expect(order).toEqual(["retire", "pool"]);
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
    expect(poolFail.markProvisioningJobOutcome).toHaveBeenCalledWith(
      BIZ,
      "failed",
      expect.stringContaining("old-box bookkeeping failed")
    );

    const neverRenewFail = makeDeps({
      markVpsNeverRenew: vi.fn(async () => {
        throw new Error("flag write failed");
      })
    });
    const neverRenewResult = await runTermRenewalSweep(neverRenewFail, { now: NOW });
    expect(neverRenewResult.migrated).toBe(0);
    expect(neverRenewResult.findings[0]?.kind).toBe("migration_failed");
    expect(neverRenewFail.markProvisioningJobOutcome).toHaveBeenCalledWith(
      BIZ,
      "failed",
      expect.stringContaining("old-box bookkeeping failed")
    );
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

  it("reports (never silently skips) a subscription without a billing_period", async () => {
    // HQ's real shape: active sub, billing_period null. The old bare
    // `continue` made the daily report indistinguishable from "nothing to
    // do"; the typed finding names who was never evaluated.
    const deps = makeDeps({
      listSubscriptionsByBusinessIds: vi.fn(
        async () => new Map([[BIZ, sub({ billing_period: null })]])
      )
    });
    const result = await runTermRenewalSweep(deps, { now: NOW });
    expect(result.checked).toBe(0);
    const skipped = result.findings.filter((f) => f.kind === "skipped_no_billing_period");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].businessId).toBe(BIZ);
    expect(skipped[0].detail).toContain("no billing_period");
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
    // This case deliberately omits `now` to exercise the default clock, so the
    // renewal date has to be relative to the real one, not a fixed literal.
    const oneDayOut = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(async () => [
        { id: "hbs-old", status: "active", total_price: 5000, next_billing_at: oneDayOut }
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
        { id: "hbs-old", status: "active", next_billing_at: "2026-07-21T00:00:00.000Z" }
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
