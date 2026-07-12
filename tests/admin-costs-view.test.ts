import { describe, it, expect } from "vitest";
import {
  buildPoolBoxBurn,
  buildRenewalCalendar,
  sumMarginLinesByKey,
  telnyxDirectionSummary,
  telnyxMonthlyTrend
} from "@/lib/admin/costs-view";
import type { HostingerVpsCostRow, TelnyxCostDailyRow } from "@/lib/db/platform-costs";
import type { VpsInventoryRow } from "@/lib/db/vps-inventory";
import type { BusinessMarginEconomics } from "@/lib/admin/margin";
import { getPeriodPricing } from "@/lib/plans/tier";
import { HOSTING_MONTHLY_CENTS_BY_SIZE } from "@/lib/plans/enterprise-pricing";

const NOW = new Date("2026-07-12T18:00:00.000Z");

function telnyxRow(overrides: Partial<TelnyxCostDailyRow> = {}): TelnyxCostDailyRow {
  return {
    id: 1,
    day: "2026-07-10",
    business_id: "biz-1",
    record_type: "messaging",
    direction: "outbound",
    record_count: 10,
    cost_micros: 159_000,
    carrier_fee_micros: 30_000,
    billed_seconds: 0,
    synced_at: "2026-07-12T11:10:00.000Z",
    ...overrides
  };
}

function hostingerRow(overrides: Partial<HostingerVpsCostRow> = {}): HostingerVpsCostRow {
  return {
    subscription_id: "sub-1",
    vm_id: 1800980,
    hostname: "srv1800980.hstgr.cloud",
    plan: "KVM 2",
    status: "active",
    billing_period: 1,
    billing_period_unit: "month",
    total_price_cents: 2449,
    renewal_price_cents: 2449,
    monthly_price_cents: 2449,
    is_auto_renewed: true,
    next_billing_at: "2026-08-02T00:00:00.000Z",
    expires_at: null,
    assigned_business_id: "biz-1",
    snapshot_at: "2026-07-12T11:10:00.000Z",
    ...overrides
  };
}

function inventoryRow(overrides: Partial<VpsInventoryRow> = {}): VpsInventoryRow {
  return {
    vm_id: 1800985,
    hostname: "srv1800985.hstgr.cloud",
    plan: "kvm2",
    state: "available",
    hostinger_billing_subscription_id: "sub-pool",
    assigned_business_id: null,
    acquired_at: "2026-07-01T00:00:00.000Z",
    assigned_at: null,
    notes: null,
    never_renew: false,
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

describe("sumMarginLinesByKey", () => {
  it("sums each line key across businesses, defaulting absent keys to 0", () => {
    const economics: BusinessMarginEconomics[] = [
      {
        businessId: "a",
        revenueCents: 0,
        revenueSource: "none",
        lines: [
          { key: "hosting", label: "", cents: 1499, source: "actual" },
          { key: "telnyx_usage", label: "", cents: 100, source: "estimate" }
        ],
        costCents: 1599,
        marginCents: -1599
      },
      {
        businessId: "b",
        revenueCents: 0,
        revenueSource: "none",
        lines: [{ key: "hosting", label: "", cents: 2449, source: "estimate" }],
        costCents: 2449,
        marginCents: -2449
      }
    ];
    expect(sumMarginLinesByKey(economics)).toEqual({
      hosting: 3948,
      did: 0,
      telnyx_usage: 100,
      gemini_chat: 0,
      gemini_voice: 0,
      stripe_fees: 0
    });
  });
});

describe("telnyxMonthlyTrend", () => {
  it("buckets by calendar month, splitting messaging counts from voice minutes", () => {
    const trend = telnyxMonthlyTrend([
      telnyxRow({ day: "2026-06-15", cost_micros: 100 }),
      telnyxRow({ day: "2026-06-20", cost_micros: 50, record_count: 5 }),
      telnyxRow({
        day: "2026-07-01",
        record_type: "sip-trunking",
        cost_micros: 200,
        billed_seconds: 120
      })
    ]);
    expect(trend).toEqual([
      { month: "2026-06", costMicros: 150, messagingCount: 15, voiceMinutes: 0 },
      { month: "2026-07", costMicros: 200, messagingCount: 0, voiceMinutes: 2 }
    ]);
  });
});

describe("telnyxDirectionSummary", () => {
  it("groups by type + direction, tracking the unattributed slice", () => {
    const summary = telnyxDirectionSummary([
      telnyxRow(),
      telnyxRow({ id: 2, business_id: null, cost_micros: 41_000 }),
      telnyxRow({ id: 3, direction: "inbound", cost_micros: 10_000 }),
      telnyxRow({
        id: 4,
        record_type: "sip-trunking",
        direction: "inbound",
        cost_micros: 5_000,
        billed_seconds: 300
      })
    ]);
    expect(summary).toEqual([
      expect.objectContaining({
        recordType: "messaging",
        direction: "inbound",
        costMicros: 10_000,
        unattributedMicros: 0
      }),
      expect.objectContaining({
        recordType: "messaging",
        direction: "outbound",
        records: 20,
        costMicros: 200_000,
        carrierFeeMicros: 60_000,
        unattributedMicros: 41_000
      }),
      expect.objectContaining({
        recordType: "sip-trunking",
        direction: "inbound",
        voiceMinutes: 5
      })
    ]);
  });
});

describe("buildRenewalCalendar", () => {
  const names = new Map([["biz-1", "Amy Laidlaw Real Estate"]]);

  it("includes renewals, lapses, and term rollovers inside the horizon, soonest first", () => {
    const events = buildRenewalCalendar({
      hostingerRows: [
        hostingerRow(), // renews Aug 2 — in window
        hostingerRow({
          subscription_id: "sub-lapse",
          vm_id: 1800985,
          hostname: null,
          plan: null,
          is_auto_renewed: false,
          status: "non_renewing",
          next_billing_at: null,
          expires_at: "2026-07-20T00:00:00.000Z",
          assigned_business_id: null,
          monthly_price_cents: null
        }),
        // Cancelled + no dates at all — skipped (NaN branch).
        hostingerRow({
          subscription_id: "sub-gone",
          status: "cancelled",
          is_auto_renewed: false,
          next_billing_at: null,
          expires_at: null
        }),
        // Past date — skipped.
        hostingerRow({
          subscription_id: "sub-past",
          next_billing_at: "2026-07-01T00:00:00.000Z"
        }),
        // Beyond the horizon — skipped.
        hostingerRow({
          subscription_id: "sub-far",
          next_billing_at: "2027-01-01T00:00:00.000Z"
        }),
        // Lapse with no expires_at falls back to next_billing_at; unknown
        // business id renders the shortened id.
        hostingerRow({
          subscription_id: "sub-lapse-2",
          vm_id: null,
          hostname: null,
          is_auto_renewed: false,
          next_billing_at: "2026-08-05T00:00:00.000Z",
          expires_at: null,
          assigned_business_id: "00000000-dead-beef-0000-000000000000"
        }),
        // Renewing row with no plan label at all.
        hostingerRow({
          subscription_id: "sub-no-plan",
          plan: null,
          next_billing_at: "2026-08-10T00:00:00.000Z"
        }),
        // Null auto-renew flag on a live subscription counts as renewing
        // (same rule as the fleet table / billing-posture cron).
        hostingerRow({
          subscription_id: "sub-null-flag",
          is_auto_renewed: null,
          next_billing_at: "2026-08-11T00:00:00.000Z"
        }),
        // non_renewing status wins over a stale auto-renew=true flag.
        hostingerRow({
          subscription_id: "sub-status-wins",
          is_auto_renewed: true,
          status: "non_renewing",
          next_billing_at: null,
          expires_at: "2026-08-12T00:00:00.000Z"
        })
      ],
      subscriptions: [
        {
          business_id: "biz-1",
          tier: "standard",
          status: "active",
          stripe_subscription_id: "sub_stripe",
          billing_period: "biennial",
          renewal_at: "2026-07-30T00:00:00.000Z"
        },
        // Every skip reason:
        {
          business_id: "biz-x",
          tier: "standard",
          status: "canceled",
          stripe_subscription_id: "s",
          billing_period: "annual",
          renewal_at: "2026-07-30T00:00:00.000Z"
        },
        {
          business_id: "biz-x",
          tier: "standard",
          status: "active",
          stripe_subscription_id: null,
          billing_period: "annual",
          renewal_at: "2026-07-30T00:00:00.000Z"
        },
        {
          business_id: "biz-x",
          tier: "enterprise",
          status: "active",
          stripe_subscription_id: "s",
          billing_period: "annual",
          renewal_at: "2026-07-30T00:00:00.000Z"
        },
        {
          business_id: "biz-x",
          tier: "standard",
          status: "active",
          stripe_subscription_id: "s",
          billing_period: null,
          renewal_at: "2026-07-30T00:00:00.000Z"
        },
        {
          business_id: "biz-x",
          tier: "standard",
          status: "active",
          stripe_subscription_id: "s",
          billing_period: "monthly",
          renewal_at: "2026-07-30T00:00:00.000Z"
        },
        {
          business_id: "biz-x",
          tier: "standard",
          status: "active",
          stripe_subscription_id: "s",
          billing_period: "annual",
          renewal_at: null
        },
        {
          business_id: "biz-x",
          tier: "standard",
          status: "active",
          stripe_subscription_id: "s",
          billing_period: "annual",
          renewal_at: "garbage"
        },
        {
          business_id: "biz-x",
          tier: "standard",
          status: "active",
          stripe_subscription_id: "s",
          billing_period: "annual",
          renewal_at: "2027-06-30T00:00:00.000Z"
        }
      ],
      businessNames: names,
      now: NOW
    });

    expect(events.map((e) => e.kind)).toEqual([
      "hostinger_lapse",
      "term_rollover",
      "hostinger_renewal",
      "hostinger_lapse",
      "hostinger_renewal",
      "hostinger_renewal",
      "hostinger_lapse"
    ]);
    const [lapse, rollover, renewal, lapse2, noPlan, nullFlag, statusWins] = events;
    expect(noPlan.detail).toBe("VPS · Amy Laidlaw Real Estate");
    expect(nullFlag.label).toContain("renews");
    expect(statusWins.label).toContain("lapses");
    expect(statusWins.at).toBe("2026-08-12T00:00:00.000Z");
    expect(lapse).toMatchObject({
      label: "VM 1800985 lapses",
      detail: expect.stringContaining("unassigned"),
      daysAway: 8,
      monthlyCents: null
    });
    const pricing = getPeriodPricing("standard", "biennial");
    expect(rollover).toMatchObject({
      label: "Amy Laidlaw Real Estate contract ends",
      monthlyCents: pricing.renewalMonthlyCents - pricing.monthlyCents,
      businessId: "biz-1"
    });
    expect(renewal).toMatchObject({
      label: "srv1800980.hstgr.cloud renews",
      detail: "KVM 2 · Amy Laidlaw Real Estate",
      monthlyCents: 2449
    });
    expect(lapse2.label).toBe("VM ? lapses");
    expect(lapse2.detail).toContain("00000000…");
  });

  it("respects a custom horizon", () => {
    const events = buildRenewalCalendar({
      hostingerRows: [hostingerRow()], // Aug 2 — 21 days out
      subscriptions: [],
      businessNames: names,
      now: NOW,
      horizonDays: 7
    });
    expect(events).toHaveLength(0);
  });
});

describe("buildPoolBoxBurn", () => {
  it("prices idle boxes from the synced billing row, falling back to the SKU table", () => {
    const burn = buildPoolBoxBurn({
      inventory: [
        inventoryRow(), // synced billing row below
        // No billing row at all → SKU estimate.
        inventoryRow({ vm_id: 42, hostname: null, plan: "kvm1", hostinger_billing_subscription_id: null }),
        // Unknown plan and no billing → null price.
        inventoryRow({ vm_id: 43, plan: "weird-plan", hostinger_billing_subscription_id: null }),
        inventoryRow({ vm_id: 44, state: "assigned" }), // not idle — skipped
        inventoryRow({ vm_id: 45, state: "retired" }),
        // Cancelled billing = sunk cost until lapse, NOT recurring burn
        // (same rule as the fleet KPI excluding cancelled subs).
        inventoryRow({ vm_id: 46 })
      ],
      hostingerRows: [
        hostingerRow({
          subscription_id: "sub-pool",
          vm_id: 1800985,
          monthly_price_cents: 2449,
          is_auto_renewed: false,
          status: "non_renewing",
          next_billing_at: null,
          expires_at: "2026-08-02T00:00:00.000Z"
        }),
        hostingerRow({
          subscription_id: "sub-cancelled",
          vm_id: 46,
          status: "cancelled",
          monthly_price_cents: 2449,
          next_billing_at: null,
          expires_at: "2026-09-01T00:00:00.000Z"
        }),
        hostingerRow({ subscription_id: "sub-no-vm", vm_id: null })
      ],
      now: NOW
    });

    expect(burn.map((b) => b.vmId)).toEqual([1800985, 46, 42, 43]);
    const cancelled = burn.find((b) => b.vmId === 46)!;
    expect(cancelled.monthlyCents).toBeNull();
    expect(cancelled.endsAt).toBe("2026-09-01T00:00:00.000Z");
    expect(burn[0]).toMatchObject({
      monthlyCents: 2449,
      monthlySource: "actual",
      autoRenew: false,
      endsAt: "2026-08-02T00:00:00.000Z",
      daysLeft: 21
    });
    expect(burn.find((b) => b.vmId === 42)).toMatchObject({
      monthlyCents: HOSTING_MONTHLY_CENTS_BY_SIZE.kvm1,
      monthlySource: "estimate",
      autoRenew: null,
      endsAt: null,
      daysLeft: null
    });
    expect(burn.find((b) => b.vmId === 43)?.monthlyCents).toBeNull();
  });

  it("falls back to next_billing_at for the clock and clamps past dates to 0 days", () => {
    const burn = buildPoolBoxBurn({
      inventory: [inventoryRow()],
      hostingerRows: [
        hostingerRow({
          subscription_id: "sub-pool",
          vm_id: 1800985,
          expires_at: null,
          next_billing_at: "2026-07-01T00:00:00.000Z" // already past
        })
      ],
      now: NOW
    });
    expect(burn[0].endsAt).toBe("2026-07-01T00:00:00.000Z");
    expect(burn[0].daysLeft).toBe(0);
  });

  it("resolves billing via the inventory's subscription id when the VM join misses", () => {
    const burn = buildPoolBoxBurn({
      inventory: [
        inventoryRow({ hostinger_billing_subscription_id: "sub-detached" }),
        inventoryRow({ vm_id: 47, hostinger_billing_subscription_id: null }),
        // Subscription id that matches no synced billing row at all.
        inventoryRow({ vm_id: 48, hostinger_billing_subscription_id: "sub-ghost" })
      ],
      hostingerRows: [
        // Billing row lost its VM (deleted box, lingering subscription).
        hostingerRow({
          subscription_id: "sub-detached",
          vm_id: null,
          status: "cancelled",
          monthly_price_cents: 2449,
          next_billing_at: null,
          expires_at: "2026-08-20T00:00:00.000Z"
        })
      ],
      now: NOW
    });
    const detached = burn.find((b) => b.vmId === 1800985)!;
    expect(detached.monthlyCents).toBeNull(); // cancelled — no recurring burn
    expect(detached.endsAt).toBe("2026-08-20T00:00:00.000Z");
    // No subscription id at all → SKU estimate fallback.
    expect(burn.find((b) => b.vmId === 47)?.monthlySource).toBe("estimate");
    // A ghost subscription id (billing row gone entirely) also estimates.
    expect(burn.find((b) => b.vmId === 48)).toMatchObject({
      monthlySource: "estimate",
      endsAt: null
    });
  });
});
