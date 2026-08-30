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
  billingSubCycleMonths,
  runContractUpgradeSweep,
  type ContractUpgradeSweepDeps
} from "@/lib/vps/contract-upgrade-sweep";
import type { BusinessRow } from "@/lib/db/businesses";
import type { SubscriptionRow } from "@/lib/db/subscriptions";
import type { CustomerProfileRow } from "@/lib/db/customer-profiles";
import type { CatalogItem } from "@/lib/hostinger/client";
import { HQ_BUSINESS_ID } from "@/lib/vps/shared-hardware";

const BIZ = "11111111-2222-3333-4444-555555555555";
const BIZ2 = "22222222-3333-4444-5555-666666666666";
const PROFILE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NOW = new Date("2026-07-20T12:00:00.000Z");
/** 24h out: inside the 36h renewal window, the run a real box is caught on. */
const NEXT_BILLING_AT = "2026-07-21T12:00:00.000Z";

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
    // Contract ends two years out, so a monthly box leaves ~23 months
    // unfunded.
    stripe_current_period_end: "2028-06-01T00:00:00.000Z",
    customer_profile_id: PROFILE,
    hostinger_billing_subscription_id: "hbs-old",
    ...overrides
  } as SubscriptionRow;
}

/** Refund window closed by default: first paid well over 30 days ago. */
function profile(overrides: Partial<CustomerProfileRow> = {}): CustomerProfileRow {
  return {
    id: PROFILE,
    first_paid_at: "2026-06-01T00:00:00.000Z",
    refund_used_at: null,
    ...overrides
  } as CustomerProfileRow;
}

/**
 * Real fleet shape: a kvm2 monthly box renews at $24.49 and a fresh 2-year
 * box is $215.76 for the whole period ($8.99/mo). Comparing those as WHOLE
 * PERIODS is the trap the per-month normalization exists to avoid.
 */
function catalog(): CatalogItem[] {
  return [
    {
      id: "hostingercom-vps-kvm2",
      name: "KVM 2",
      category: "VPS",
      prices: [
        {
          id: "hostingercom-vps-kvm2-usd-1m",
          name: "1m",
          currency: "USD",
          price: 2449,
          period: 1,
          period_unit: "month"
        },
        {
          id: "hostingercom-vps-kvm2-usd-1y",
          name: "1y",
          currency: "USD",
          price: 17988,
          first_period_price: 13188,
          period: 1,
          period_unit: "year"
        },
        {
          id: "hostingercom-vps-kvm2-usd-2y",
          name: "2y",
          currency: "USD",
          price: 47976,
          first_period_price: 21576,
          period: 2,
          period_unit: "year"
        }
      ]
    }
  ];
}

/** A MONTHLY Hostinger box: created a month ago, renewing tomorrow. */
function monthlyBillingSub(overrides: Record<string, unknown> = {}) {
  return {
    id: "hbs-old",
    status: "active",
    renewal_price: 2449,
    billing_period: 1,
    billing_period_unit: "month",
    created_at: "2026-06-21T12:00:00.000Z",
    next_billing_at: NEXT_BILLING_AT,
    ...overrides
  };
}

function makeDeps(
  overrides: Partial<ContractUpgradeSweepDeps> = {}
): ContractUpgradeSweepDeps {
  return {
    listBusinesses: vi.fn(async () => [biz()]),
    listBusinessIdsWithLiveSubscription: vi.fn(async (ids: string[]) => ({
      stripeBacked: new Set(ids),
      stripeless: new Set<string>(),
      cancelAtPeriodEnd: new Set<string>()
    })),
    listSubscriptionsByBusinessIds: vi.fn(async () => new Map([[BIZ, sub()]])),
    listCustomerProfilesByIds: vi.fn(async () => new Map([[PROFILE, profile()]])),
    listCatalog: vi.fn(async () => catalog()),
    listBillingSubscriptions: vi.fn(async () => [monthlyBillingSub()] as never),
    hasActiveVpsMigrationLock: vi.fn(async () => false),
    getLastContractUpgradePurchaseAt: vi.fn(async () => null),
    tryClaimVpsMigration: vi.fn(async () => true),
    releaseVpsMigrationLock: vi.fn(async () => undefined),
    getBusiness: vi.fn(async () => biz()),
    getSubscription: vi.fn(async () => sub()),
    updateSubscription: vi.fn(async () => ({})),
    getActiveVpsSshKey: vi.fn(
      async () =>
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
      listBillingSubscriptions: vi.fn(
        async () =>
          [
            { id: "hbs-new", resource_id: "1900001" },
            { id: "hbs-old", resource_id: "1800985" }
          ] as never
      ),
      disableBillingAutoRenewal: vi.fn(async () => ({}) as never)
    },
    backupBusinessData: vi.fn(async (_input, opts) => {
      await opts?.sshKeyLookup?.(BIZ);
      return { storagePath: "backups/biz.tgz", sizeBytes: 100, sha256: "abc" };
    }),
    restoreBusinessData: vi.fn(async () => ({})),
    orchestrateProvisioning: vi.fn(async () => ({
      vpsId: "1900001",
      hostingerBillingSubscriptionId: "hbs-new"
    })),
    enqueueProvisioningJob: vi.fn(async () => undefined),
    // Mirrors the real runner, INCLUDING forwarding hostinger_term: the whole
    // point of persisting the term on the job row is that the run uses the
    // term the sweep computed rather than re-deriving one.
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
        hostingerTerm:
          job.hostinger_term === "1m" || job.hostinger_term === "1y" || job.hostinger_term === "2y"
            ? job.hostinger_term
            : null,
        skipPoolAdopt: job.skip_pool_adopt === true ? true : undefined,
        suppressOwnerNotify: job.suppress_owner_notify === true ? true : undefined
      });
      return {
        hostingerBillingSubscriptionId: out.hostingerBillingSubscriptionId,
        vpsId: out.vpsId ?? "1900001",
        deploySucceeded: out.deploySucceeded
      };
    }),
    markProvisioningJobOutcome: vi.fn(async () => undefined),
    tryRecoverDeployCompleteNewBox: vi.fn(async () => null),
    releaseVpsToPool: vi.fn(async () => "pooled" as const),
    markVpsNeverRenew: vi.fn(async () => undefined),
    retireVpsSshKeysForVps: vi.fn(async () => 1),
    sendOpsEmail: vi.fn(async () => undefined),
    ...overrides
  } as ContractUpgradeSweepDeps;
}

function run(deps: ContractUpgradeSweepDeps) {
  return runContractUpgradeSweep(deps, { now: NOW });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("billingSubCycleMonths", () => {
  it("reads a monthly Hostinger cycle as 1", () => {
    expect(billingSubCycleMonths({ billing_period: 1, billing_period_unit: "month" })).toBe(1);
  });

  it("reads a two-year cycle as 24 and a one-year cycle as 12", () => {
    expect(billingSubCycleMonths({ billing_period: 2, billing_period_unit: "year" })).toBe(24);
    expect(billingSubCycleMonths({ billing_period: 1, billing_period_unit: "year" })).toBe(12);
  });

  /**
   * Regression, found by Bugbot on #1391. An earlier version inferred the
   * cycle from `created_at` to `expires_at`. `created_at` is the original
   * PURCHASE date, not the current cycle start, so a monthly box bought
   * seven months ago measured as a seven-month cycle, its single-month
   * renewal price divided by seven, and cents-per-month came out 7x too
   * low, failing the savings gate for exactly the long-standing monthly
   * tenants this sweep exists to move onto term hardware.
   */
  it("reads an OLD monthly box as a 1-month cycle, not the span since purchase", () => {
    expect(
      billingSubCycleMonths({
        billing_period: 1,
        billing_period_unit: "month",
        // Seven months of history on a box that still bills monthly.
        created_at: "2026-01-01T00:00:00.000Z",
        next_billing_at: "2026-08-01T00:00:00.000Z"
      } as never)
    ).toBe(1);
  });

  // Live API (Jul 2026) returns billing_period/billing_period_unit; the
  // legacy pair is the documented fallback for older response shapes.
  it("falls back to the legacy period fields", () => {
    expect(billingSubCycleMonths({ period: 2, period_unit: "year" })).toBe(24);
  });

  it("prefers the modern fields over the legacy ones", () => {
    expect(
      billingSubCycleMonths({
        billing_period: 1,
        billing_period_unit: "month",
        period: 2,
        period_unit: "year"
      })
    ).toBe(1);
  });

  it("returns null when Hostinger reports no cycle at all", () => {
    expect(billingSubCycleMonths({})).toBeNull();
  });

  // A period with no unit is not a cycle we can read. Treated as unknown
  // rather than assumed to be months, which would mis-price a purchase.
  it("returns null when the period has no unit", () => {
    expect(billingSubCycleMonths({ billing_period: 2 })).toBeNull();
  });

  // Guessing an unrecognised unit would mis-price a real purchase.
  it("returns null for an unrecognised unit", () => {
    expect(billingSubCycleMonths({ billing_period: 1, billing_period_unit: "week" })).toBeNull();
  });
});

describe("runContractUpgradeSweep, the happy path", () => {
  it("moves a contract tenant off a monthly box onto a 2-year one", async () => {
    const deps = makeDeps();
    const result = await run(deps);

    expect(result.checked).toBe(1);
    expect(result.migrated).toBe(1);
    expect(result.findings.map((f) => f.kind)).toEqual(["migrated"]);
    expect(result.findings[0].term).toBe("2y");
    // Contract runs to 2028-06-01; the monthly box is paid to 2026-07-21.
    expect(result.findings[0].shortfallMonths).toBe(23);
  });

  // The term is COMPUTED, persisted on the job row, and has to arrive at the
  // purchase. Re-deriving it from billing_period would work here by luck and
  // break for the adopted-box case below, so this asserts the whole path.
  it("carries the computed term through the job ledger to the purchase", async () => {
    const deps = makeDeps();
    await run(deps);

    expect(deps.enqueueProvisioningJob).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "contract_upgrade", hostingerTerm: "2y" })
    );
    expect(deps.orchestrateProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({ hostingerTerm: "2y", skipPoolAdopt: true })
    );
  });

  it("pools the old box and marks it never_renew", async () => {
    const deps = makeDeps();
    await run(deps);

    expect(deps.releaseVpsToPool).toHaveBeenCalledWith(
      expect.objectContaining({
        vmId: 1800985,
        expiresAt: NEXT_BILLING_AT,
        notes: expect.stringContaining("contract-upgrade-sweep")
      })
    );
    expect(deps.markVpsNeverRenew).toHaveBeenCalledWith(1800985);
  });

  /**
   * #1390 added the old-box key retire to the shared migration, which this
   * sweep also drives. Asserted here rather than assumed: the fix was
   * written for term renewals, and a contract upgrade moves a tenant to
   * different hardware exactly the same way, so leaving the old row active
   * would put dead boxes back in front of every fleet sweep.
   */
  it("retires the old box's ssh key row, so fleet sweeps stop SSHing into it", async () => {
    const deps = makeDeps();
    await run(deps);
    expect(deps.retireVpsSshKeysForVps).toHaveBeenCalledWith("1800985");
  });

  // Mirrors the ordering assertion #1390 added on the term-renewal side. A
  // pooled box must not carry an active key belonging to its previous
  // tenant: with the row already retired, adoptVpsForBusiness finds none and
  // mints a fresh keypair instead of reusing the departed tenant's.
  it("retires the old key row BEFORE returning the box to the pool", async () => {
    const order: string[] = [];
    const deps = makeDeps();
    (deps.retireVpsSshKeysForVps as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("retire");
      return 1;
    });
    (deps.releaseVpsToPool as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("pool");
    });
    const result = await run(deps);
    expect(result.migrated).toBe(1);
    expect(order).toEqual(["retire", "pool"]);
  });

  // The retire reads nothing, but the BACKUP before it SSHes into the old box
  // with the very key being retired, so the stamp must land after the data is
  // safely on the new box.
  it("retires only after the backup and restore have used that key", async () => {
    const order: string[] = [];
    const deps = makeDeps();
    (deps.backupBusinessData as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("backup");
      return { storagePath: "backups/biz.tgz", sizeBytes: 100, sha256: "abc" };
    });
    (deps.restoreBusinessData as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("restore");
      return {};
    });
    (deps.retireVpsSshKeysForVps as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("retire");
      return 1;
    });
    await run(deps);
    expect(order).toEqual(["backup", "restore", "retire"]);
  });

  it("does not fail a good cutover when the key retire fails", async () => {
    const deps = makeDeps({
      retireVpsSshKeysForVps: vi.fn(async () => {
        throw new Error("keys db down");
      })
    });
    const result = await run(deps);
    expect(result.migrated).toBe(1);
  });

  it("releases the migration lease when the migration finishes", async () => {
    const deps = makeDeps();
    await run(deps);
    expect(deps.tryClaimVpsMigration).toHaveBeenCalledWith(
      BIZ,
      "contract-upgrade-sweep",
      "kvm2"
    );
    expect(deps.releaseVpsMigrationLock).toHaveBeenCalledWith(BIZ);
  });
});

describe("runContractUpgradeSweep, gate 1: refund exposure", () => {
  // The whole reason this sweep exists. Buying a non-refundable 2-year box
  // for a customer who can still ask for their money back is exactly the
  // exposure the new strategy removes.
  it("refuses to buy term hardware while the money-back window is open", async () => {
    const deps = makeDeps({
      listCustomerProfilesByIds: vi.fn(
        async () => new Map([[PROFILE, profile({ first_paid_at: "2026-07-18T00:00:00.000Z" })]])
      )
    });
    const result = await run(deps);

    expect(result.migrated).toBe(0);
    expect(result.findings[0].kind).toBe("skipped_refund_window_open");
    expect(deps.enqueueProvisioningJob).not.toHaveBeenCalled();
    expect(deps.hostinger.getVirtualMachine).not.toHaveBeenCalled();
  });

  // A customer who already spent their lifetime-once refund carries no
  // exposure, so they are eligible immediately rather than after an
  // arbitrary 30 days.
  it("proceeds once the lifetime refund has been used, even inside 30 days", async () => {
    const deps = makeDeps({
      listCustomerProfilesByIds: vi.fn(
        async () =>
          new Map([
            [
              PROFILE,
              profile({
                first_paid_at: "2026-07-18T00:00:00.000Z",
                refund_used_at: "2026-07-19T00:00:00.000Z"
              })
            ]
          ])
      )
    });
    const result = await run(deps);
    expect(result.migrated).toBe(1);
  });

  it("refuses when the subscription carries no customer profile", async () => {
    const deps = makeDeps({
      listSubscriptionsByBusinessIds: vi.fn(
        async () => new Map([[BIZ, sub({ customer_profile_id: null })]])
      )
    });
    const result = await run(deps);

    expect(result.migrated).toBe(0);
    expect(result.findings[0].kind).toBe("skipped_refund_window_open");
    expect(result.findings[0].detail).toMatch(/no customer profile/);
  });

  it("refuses when the profile row is missing entirely", async () => {
    const deps = makeDeps({
      listCustomerProfilesByIds: vi.fn(async () => new Map())
    });
    const result = await run(deps);
    expect(result.migrated).toBe(0);
    expect(result.findings[0].kind).toBe("skipped_refund_window_open");
  });
});

describe("runContractUpgradeSweep, gate 2: contract coverage", () => {
  it("ignores month-to-month tenants entirely", async () => {
    const deps = makeDeps({
      listSubscriptionsByBusinessIds: vi.fn(
        async () => new Map([[BIZ, sub({ billing_period: "monthly" })]])
      )
    });
    const result = await run(deps);

    expect(result.checked).toBe(0);
    expect(result.migrated).toBe(0);
    // Not even a profile lookup: monthly tenants have nothing to cover.
    expect(deps.listCustomerProfilesByIds).toHaveBeenCalledWith([]);
  });

  it("leaves a tenant alone when their box already funds the whole contract", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(
        async () =>
          [
            monthlyBillingSub({
              billing_period: 2,
              billing_period_unit: "year",
              expires_at: "2028-07-01T00:00:00.000Z",
              next_billing_at: "2028-07-01T00:00:00.000Z"
            })
          ] as never
      )
    });
    const result = await run(deps);

    expect(result.alreadyCovered).toBe(1);
    expect(result.migrated).toBe(0);
    expect(result.findings[0].kind).toBe("skipped_covered");
  });

  // A contract tenant whose Stripe period bounds were invalidated (the
  // cancel path nulls them) has no target to cover. Reported rather than
  // migrated: we will not guess a contract end.
  it("reports a contract with no readable Stripe period end", async () => {
    const deps = makeDeps({
      listSubscriptionsByBusinessIds: vi.fn(
        async () => new Map([[BIZ, sub({ stripe_current_period_end: null })]])
      )
    });
    const result = await run(deps);

    expect(result.checked).toBe(1);
    expect(result.alreadyCovered).toBe(1);
    expect(result.migrated).toBe(0);
    expect(result.findings[0].kind).toBe("skipped_covered");
    expect(result.findings[0].detail).toMatch(/no readable Stripe period end/);
  });

  it("skips an inactive subscription", async () => {
    const deps = makeDeps({
      listSubscriptionsByBusinessIds: vi.fn(
        async () => new Map([[BIZ, sub({ status: "canceled" })]])
      )
    });
    expect((await run(deps)).checked).toBe(0);
  });

  // A tenant who told us they are leaving at period end must not have money
  // spent on hardware for a contract they are not continuing.
  it("excludes a tenant who scheduled cancellation", async () => {
    const deps = makeDeps({
      listBusinessIdsWithLiveSubscription: vi.fn(async (ids: string[]) => ({
        stripeBacked: new Set(ids),
        stripeless: new Set<string>(),
        cancelAtPeriodEnd: new Set(ids)
      }))
    });
    expect((await run(deps)).checked).toBe(0);
  });

  it("skips a wiped business and one with no VM", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn(async () => [
        biz({ status: "wiped" }),
        biz({ id: BIZ2, hostinger_vps_id: null })
      ])
    });
    expect((await run(deps)).checked).toBe(0);
  });
});

describe("runContractUpgradeSweep, gate 3: the renewal window", () => {
  /**
   * The adopted-box case. Someone churned mid-contract, their box went to
   * the pool with a year of prepaid runway, and a new 24-month tenant
   * adopted it. That prepaid year is already paid for, so the tenant must be
   * left alone until the box is nearly out of runway.
   */
  it("leaves an adopted long-runway box alone until it is nearly out of time", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(
        async () =>
          [
            monthlyBillingSub({
              billing_period: 1,
              billing_period_unit: "year",
              created_at: "2026-07-01T00:00:00.000Z",
              next_billing_at: "2027-07-01T00:00:00.000Z",
              expires_at: "2027-07-01T00:00:00.000Z",
              renewal_price: 17988
            })
          ] as never
      )
    });
    const result = await run(deps);

    expect(result.migrated).toBe(0);
    expect(result.findings[0].kind).toBe("skipped_not_due");
    // It still knows what it WILL need: 11 months to finish the contract.
    expect(result.findings[0].shortfallMonths).toBe(11);
    expect(result.findings[0].term).toBe("1y");
    expect(deps.enqueueProvisioningJob).not.toHaveBeenCalled();
  });

  /**
   * The same tenant, a year later, now inside the box's renewal window.
   * They need only the REMAINING contract, so this buys a 1y box, not
   * another 2y one. This is the "smart runway" behavior.
   */
  it("buys only the remaining term when the adopted box finally runs out", async () => {
    const nearlyOut = new Date("2027-06-30T12:00:00.000Z");
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(
        async () =>
          [
            monthlyBillingSub({
              billing_period: 1,
              billing_period_unit: "year",
              created_at: "2026-07-01T00:00:00.000Z",
              next_billing_at: "2027-07-01T00:00:00.000Z",
              expires_at: "2027-07-01T00:00:00.000Z",
              renewal_price: 17988
            })
          ] as never
      )
    });
    const result = await runContractUpgradeSweep(deps, { now: nearlyOut });

    expect(result.migrated).toBe(1);
    expect(result.findings[0].term).toBe("1y");
    expect(result.findings[0].shortfallMonths).toBe(11);
    expect(deps.orchestrateProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({ hostingerTerm: "1y" })
    );
  });

  it("waits when the box renews outside the window", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(
        async () => [monthlyBillingSub({ next_billing_at: "2026-08-15T12:00:00.000Z" })] as never
      )
    });
    const result = await run(deps);
    expect(result.migrated).toBe(0);
    expect(result.findings[0].kind).toBe("skipped_not_due");
  });

  // Surfaced rather than silently dropped: a box we can never time is a
  // tenant who would otherwise sit on short-runway hardware forever.
  it("reports a box whose renewal date Hostinger will not tell us", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(
        async () =>
          [
            {
              id: "hbs-old",
              status: "active",
              renewal_price: 2449,
              billing_period: 1,
              billing_period_unit: "month",
              created_at: "2026-06-21T12:00:00.000Z"
            }
          ] as never
      )
    });
    const result = await run(deps);
    expect(result.migrated).toBe(0);
    expect(result.findings[0].kind).toBe("skipped_unknown_renewal");
  });
});

describe("runContractUpgradeSweep, economics", () => {
  /**
   * The trap this sweep was most likely to fall into. Compared as whole
   * periods, a $215.76 two-year first period against a $24.49 monthly
   * renewal reads as a ~9x price INCREASE, and every upgrade would be
   * skipped as uneconomic while the sweep reported itself healthy.
   */
  it("compares per MONTH, so a 2-year box beats a monthly renewal", async () => {
    const result = await run(makeDeps());
    expect(result.findings[0].kind).toBe("migrated");
    // $24.49/mo -> $8.99/mo
    expect(result.findings[0].savingsRatio).toBeCloseTo(0.6329, 3);
  });

  it("skips when the target SKU is missing from the catalog", async () => {
    const deps = makeDeps({
      listCatalog: vi.fn(async () => [
        {
          id: "hostingercom-vps-kvm2",
          name: "KVM 2",
          category: "VPS",
          prices: [
            {
              id: "hostingercom-vps-kvm2-usd-1m",
              name: "1m",
              currency: "USD",
              price: 2449,
              period: 1,
              period_unit: "month"
            }
          ]
        }
      ])
    });
    const result = await run(deps);
    expect(result.migrated).toBe(0);
    expect(result.findings[0].kind).toBe("skipped_economics");
    expect(result.findings[0].detail).toMatch(/hostinger-term-prices/);
  });

  it("skips when the current box's per-month cost cannot be read", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(
        async () => [monthlyBillingSub({ renewal_price: undefined, total_price: undefined })] as never
      )
    });
    const result = await run(deps);
    expect(result.migrated).toBe(0);
    expect(result.findings[0].kind).toBe("skipped_economics");
  });

  it("skips when the saving does not clear the threshold", async () => {
    const deps = makeDeps();
    const result = await runContractUpgradeSweep(deps, { now: NOW, savingsThreshold: 0.9 });
    expect(result.migrated).toBe(0);
    expect(result.findings[0].kind).toBe("skipped_economics");
    expect(result.findings[0].detail).toMatch(/need 90%/);
  });
});

describe("runContractUpgradeSweep, safety guards", () => {
  it("skips a business that already holds a migration lease", async () => {
    const deps = makeDeps({ hasActiveVpsMigrationLock: vi.fn(async () => true) });
    const result = await run(deps);
    expect(result.findings[0].kind).toBe("skipped_in_flight");
    expect(deps.tryClaimVpsMigration).not.toHaveBeenCalled();
  });

  it("skips when the migration lease cannot be claimed", async () => {
    const deps = makeDeps({ tryClaimVpsMigration: vi.fn(async () => false) });
    const result = await run(deps);
    expect(result.findings[0].kind).toBe("skipped_in_flight");
    expect(deps.enqueueProvisioningJob).not.toHaveBeenCalled();
  });

  // A recent purchase plus continued eligibility means that purchase never
  // finished cutover. Buying again just strands a second paid box.
  it("cools down after its own recent purchase", async () => {
    const deps = makeDeps({
      getLastContractUpgradePurchaseAt: vi.fn(async () => new Date("2026-07-19T12:00:00.000Z"))
    });
    const result = await run(deps);
    expect(result.migrated).toBe(0);
    expect(result.findings[0].kind).toBe("skipped_cooldown");
    expect(deps.enqueueProvisioningJob).not.toHaveBeenCalled();
  });

  it("does not cool down on a purchase older than the window", async () => {
    const deps = makeDeps({
      getLastContractUpgradePurchaseAt: vi.fn(async () => new Date("2026-06-01T12:00:00.000Z"))
    });
    expect((await run(deps)).migrated).toBe(1);
  });

  // BYOS and OVH boxes are excluded at the fleet scan by `tenantVmId`, one
  // layer earlier than the per-candidate guard, so they never cost a
  // Hostinger lookup. A customer-owned box has no Hostinger term to buy.
  it("never even scans a non-Hostinger placement", async () => {
    for (const provider of ["byos", "ovh"] as const) {
      const deps = makeDeps({
        listBusinesses: vi.fn(async () => [biz({ vps_provider: provider })]),
        getBusiness: vi.fn(async () => biz({ vps_provider: provider }))
      });
      const result = await run(deps);
      expect(result.checked).toBe(0);
      expect(result.migrated).toBe(0);
      expect(deps.hostinger.getVirtualMachine).not.toHaveBeenCalled();
    }
  });

  it("refuses a data-residency tenant whose datastore lives on the box", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn(async () => [biz({ data_residency_mode: "vps" })]),
      getBusiness: vi.fn(async () => biz({ data_residency_mode: "vps" }))
    });
    const result = await run(deps);
    expect(result.findings[0].kind).toBe("skipped_guard");
    expect(result.findings[0].detail).toMatch(/data_residency_mode/);
  });

  it("refuses a tenant on shared hardware", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn(async () => [biz({ id: HQ_BUSINESS_ID })]),
      listSubscriptionsByBusinessIds: vi.fn(
        async () => new Map([[HQ_BUSINESS_ID, sub({ business_id: HQ_BUSINESS_ID })]])
      ),
      getBusiness: vi.fn(async () => biz({ id: HQ_BUSINESS_ID }))
    });
    const result = await run(deps);
    expect(result.findings[0].kind).toBe("skipped_guard");
    expect(result.findings[0].detail).toMatch(/shared hardware/);
  });

  it("refuses a business mid partial-cutover", async () => {
    const deps = makeDeps({
      hostinger: {
        ...makeDeps().hostinger,
        getVirtualMachine: vi.fn(async (id: number) => ({
          id,
          state: "running",
          plan: "KVM 2",
          ipv4: [{ id: 1, address: "1.2.3.4" }],
          // Business points at a DIFFERENT billing subscription than the
          // subscriptions row does.
          subscription_id: "hbs-somewhere-else"
        }))
      } as never
    });
    const result = await run(deps);
    expect(result.findings[0].kind).toBe("skipped_guard");
    expect(result.findings[0].detail).toMatch(/partial cutover/);
  });

  it("skips a tenant whose VM lookup fails rather than acting blind", async () => {
    const deps = makeDeps({
      hostinger: {
        ...makeDeps().hostinger,
        getVirtualMachine: vi.fn(async () => {
          throw new Error("hostinger 500");
        })
      } as never
    });
    const result = await run(deps);
    expect(result.migrated).toBe(0);
    expect(result.findings).toEqual([]);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "contract-upgrade sweep: VM lookup failed",
      expect.objectContaining({ businessId: BIZ })
    );
  });

  it("skips when no Hostinger billing subscription can be resolved", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(async () => [] as never),
      hostinger: {
        ...makeDeps().hostinger,
        getVirtualMachine: vi.fn(async (id: number) => ({
          id,
          state: "running",
          plan: "KVM 2",
          ipv4: [{ id: 1, address: "1.2.3.4" }]
        }))
      } as never,
      listSubscriptionsByBusinessIds: vi.fn(
        async () => new Map([[BIZ, sub({ hostinger_billing_subscription_id: null })]])
      )
    });
    const result = await run(deps);
    expect(result.migrated).toBe(0);
    expect(result.findings).toEqual([]);
  });
});

describe("runContractUpgradeSweep, run budget and ordering", () => {
  it("migrates at most one tenant per run", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn(async () => [biz(), biz({ id: BIZ2, hostinger_vps_id: "1800986" })]),
      listSubscriptionsByBusinessIds: vi.fn(
        async () =>
          new Map([
            [BIZ, sub()],
            [BIZ2, sub({ id: "sub-2", business_id: BIZ2 })]
          ])
      )
    });
    const result = await run(deps);

    expect(result.checked).toBe(2);
    expect(result.migrated).toBe(1);
    expect(result.findings.filter((f) => f.kind === "migrated")).toHaveLength(1);
    expect(deps.enqueueProvisioningJob).toHaveBeenCalledTimes(1);
  });

  it("takes the tenant whose box runs out soonest", async () => {
    const soon = "2026-07-20T18:00:00.000Z";
    const later = "2026-07-21T18:00:00.000Z";
    const deps = makeDeps({
      listBusinesses: vi.fn(async () => [
        biz({ hostinger_vps_id: "1800985" }),
        biz({ id: BIZ2, hostinger_vps_id: "1800986" })
      ]),
      listSubscriptionsByBusinessIds: vi.fn(
        async () =>
          new Map([
            [BIZ, sub({ hostinger_billing_subscription_id: "hbs-later" })],
            [BIZ2, sub({ id: "sub-2", business_id: BIZ2, hostinger_billing_subscription_id: "hbs-soon" })]
          ])
      ),
      listBillingSubscriptions: vi.fn(
        async () =>
          [
            monthlyBillingSub({ id: "hbs-later", next_billing_at: later }),
            monthlyBillingSub({ id: "hbs-soon", next_billing_at: soon })
          ] as never
      ),
      hostinger: {
        ...makeDeps().hostinger,
        getVirtualMachine: vi.fn(async (id: number) => ({
          id,
          state: "running",
          plan: "KVM 2",
          ipv4: [{ id: 1, address: "1.2.3.4" }],
          subscription_id: id === 1800985 ? "hbs-later" : "hbs-soon"
        }))
      } as never,
      getBusiness: vi.fn(async () => biz({ id: BIZ2, hostinger_vps_id: "1800986" }))
    });

    const result = await run(deps);
    const migratedFinding = result.findings.find((f) => f.kind === "migrated");
    expect(migratedFinding?.businessId).toBe(BIZ2);
  });
});

describe("runContractUpgradeSweep, failure handling", () => {
  it("records a failed migration and still releases the lease", async () => {
    const deps = makeDeps({
      backupBusinessData: vi.fn(async () => {
        throw new Error("ssh dead");
      })
    });
    const result = await run(deps);

    expect(result.migrated).toBe(0);
    expect(result.findings[0].kind).toBe("migration_failed");
    expect(result.findings[0].detail).toMatch(/backup failed/);
    expect(deps.releaseVpsMigrationLock).toHaveBeenCalledWith(BIZ);
  });

  it("swallows a lease-release failure so the sweep still returns its result", async () => {
    const deps = makeDeps({
      releaseVpsMigrationLock: vi.fn(async () => {
        throw new Error("lease db down");
      })
    });
    const result = await run(deps);

    expect(result.migrated).toBe(1);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "contract-upgrade sweep: migration lock release failed",
      expect.objectContaining({ businessId: BIZ })
    );
  });

  it("stringifies a non-Error rejection rather than logging [object Object]", async () => {
    const deps = makeDeps({
      releaseVpsMigrationLock: vi.fn(async () => {
        throw "lease string blowup";
      })
    });
    await run(deps);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "contract-upgrade sweep: migration lock release failed",
      expect.objectContaining({ error: "lease string blowup" })
    );
  });

  // Production passes no clock. The fixture's renewal date is in the past
  // relative to the real one, so this asserts the default path runs and
  // decides nothing rather than throwing.
  it("falls back to the real clock when no now is injected", async () => {
    const deps = makeDeps();
    const result = await runContractUpgradeSweep(deps);
    expect(result.migrated).toBe(0);
    expect(deps.enqueueProvisioningJob).not.toHaveBeenCalled();
  });

  // The old box must keep running and renewing when the new one did not
  // deploy cleanly: cutting over would strand the tenant on a broken box.
  it("refuses cutover when the new box's deploy failed", async () => {
    const deps = makeDeps({
      orchestrateProvisioning: vi.fn(async () => ({
        vpsId: "1900001",
        hostingerBillingSubscriptionId: "hbs-new",
        deploySucceeded: false
      }))
    });
    const result = await run(deps);

    expect(result.migrated).toBe(0);
    expect(result.findings[0].kind).toBe("migration_failed");
    expect(deps.hostinger.stopVirtualMachine).not.toHaveBeenCalled();
    expect(deps.releaseVpsToPool).not.toHaveBeenCalled();
  });
});

/**
 * The 2026-08-28/29 incident: two consecutive migration_failed findings
 * recorded ok=true, error_count=0, because the recorder counts only the
 * errors/failures keys and these sweeps reported failures under findings.
 * Day one paged nothing; day two paged only because a retry budget tripped
 * the slow threshold. failures[] is the channel the recorder counts, so a
 * failed migration pages as a partial failure the same night.
 */
describe("failures mirror migration_failed findings for the run recorder", () => {
  it("is empty when nothing failed", async () => {
    const result = await run(makeDeps());
    expect(result.failures).toEqual([]);
  });

  it("carries one line per migration_failed, naming tenant, vm, and detail", async () => {
    const deps = makeDeps({
      backupBusinessData: vi.fn(async () => {
        throw new Error("ssh dead");
      })
    });
    const result = await run(deps);
    const failed = result.findings.filter((f) => f.kind === "migration_failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(result.failures).toHaveLength(failed.length);
    for (const f of failed) {
      expect(result.failures.join(" ")).toContain(f.businessName);
      expect(result.failures.join(" ")).toContain(String(f.vmId));
      expect(result.failures.join(" ")).toContain(f.detail);
    }
  });
});
