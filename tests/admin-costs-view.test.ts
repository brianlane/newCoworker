import { describe, it, expect } from "vitest";
import {
  TELNYX_SERIES_OTHER,
  TELNYX_SERIES_UNATTRIBUTED,
  TELNYX_USAGE_WINDOW_KEYS,
  buildPoolBoxBurn,
  buildRenewalCalendar,
  buildTelnyxDailySeries,
  buildUnattributedSenders,
  buildTelnyxTenantWindowBreakdown,
  resolveTelnyxUsageWindowKey,
  sumMarginLinesByKey,
  telnyxDirectionSummary,
  telnyxMonthlyTrend,
  telnyxUsageWindow
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
    sender: null,
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
    expires_at: null,
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
        hostingerRow(), // renews Aug 2, in window
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
        // Cancelled + no dates at all, skipped (NaN branch).
        hostingerRow({
          subscription_id: "sub-gone",
          status: "cancelled",
          is_auto_renewed: false,
          next_billing_at: null,
          expires_at: null
        }),
        // Past date, skipped.
        hostingerRow({
          subscription_id: "sub-past",
          next_billing_at: "2026-07-01T00:00:00.000Z"
        }),
        // Beyond the horizon, skipped.
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
      hostingerRows: [hostingerRow()], // Aug 2, 21 days out
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
        inventoryRow({ vm_id: 44, state: "assigned" }), // not idle, skipped
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
    expect(detached.monthlyCents).toBeNull(); // cancelled, no recurring burn
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

describe("resolveTelnyxUsageWindowKey", () => {
  it("accepts every window key", () => {
    for (const key of TELNYX_USAGE_WINDOW_KEYS) {
      expect(resolveTelnyxUsageWindowKey(key)).toBe(key);
    }
  });

  it("falls back to 14d for missing or unknown values", () => {
    expect(resolveTelnyxUsageWindowKey(undefined)).toBe("14d");
    expect(resolveTelnyxUsageWindowKey("")).toBe("14d");
    expect(resolveTelnyxUsageWindowKey("bogus")).toBe("14d");
    expect(resolveTelnyxUsageWindowKey("today")).toBe("14d");
  });
});

describe("telnyxUsageWindow", () => {
  it("builds rolling UTC windows ending tomorrow-exclusive", () => {
    expect(telnyxUsageWindow("7d", NOW)).toEqual({
      key: "7d",
      startYmd: "2026-07-06",
      endYmdExclusive: "2026-07-13"
    });
    expect(telnyxUsageWindow("14d", NOW).startYmd).toBe("2026-06-29");
    expect(telnyxUsageWindow("30d", NOW).startYmd).toBe("2026-06-13");
    expect(telnyxUsageWindow("90d", NOW).startYmd).toBe("2026-04-14");
  });

  it("crosses month boundaries in UTC, covering a reload-trace window", () => {
    expect(telnyxUsageWindow("7d", new Date("2026-08-01T00:30:00.000Z"))).toEqual({
      key: "7d",
      startYmd: "2026-07-26",
      endYmdExclusive: "2026-08-02"
    });
  });

  it("crosses year boundaries", () => {
    expect(telnyxUsageWindow("14d", new Date("2026-01-02T12:00:00.000Z"))).toEqual({
      key: "14d",
      startYmd: "2025-12-20",
      endYmdExclusive: "2026-01-03"
    });
  });
});

describe("buildTelnyxDailySeries", () => {
  const sevenDayWindow = telnyxUsageWindow("7d", NOW);

  it("zero-fills every window day, oldest first", () => {
    const series = buildTelnyxDailySeries(
      [
        telnyxRow({ day: "2026-07-06", business_id: "biz-2", cost_micros: 40_000 }),
        telnyxRow({ day: "2026-07-10", cost_micros: 100_000 })
      ],
      sevenDayWindow
    );
    expect(series.points).toHaveLength(7);
    expect(series.points.map((p) => p.day)).toEqual([
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
      "2026-07-12"
    ]);
    expect(series.points[0]).toEqual({
      day: "2026-07-06",
      costMicros: 40_000,
      segments: [{ seriesKey: "biz-2", costMicros: 40_000 }]
    });
    expect(series.points[1]).toEqual({ day: "2026-07-07", costMicros: 0, segments: [] });
  });

  it("ignores rows outside the window on both bounds", () => {
    const series = buildTelnyxDailySeries(
      [
        telnyxRow({ day: "2026-07-05", cost_micros: 999_000 }),
        telnyxRow({ day: "2026-07-13", cost_micros: 999_000 }),
        telnyxRow({ day: "2026-07-06", cost_micros: 10_000 }),
        telnyxRow({ day: "2026-07-12", cost_micros: 5_000 })
      ],
      sevenDayWindow
    );
    expect(series.totalMicros).toBe(15_000);
  });

  it("merges a tenant's messaging and voice rows into one segment per day", () => {
    const series = buildTelnyxDailySeries(
      [
        telnyxRow({ day: "2026-07-10", cost_micros: 100_000 }),
        telnyxRow({
          day: "2026-07-10",
          record_type: "sip-trunking",
          billed_seconds: 300,
          cost_micros: 50_000
        })
      ],
      sevenDayWindow
    );
    const day = series.points.find((p) => p.day === "2026-07-10");
    expect(day?.segments).toEqual([{ seriesKey: "biz-1", costMicros: 150_000 }]);
    expect(series.maxMicros).toBe(150_000);
    expect(series.totalMicros).toBe(150_000);
  });

  it("keeps segments in fixed series order even when a smaller series spikes", () => {
    const series = buildTelnyxDailySeries(
      [
        telnyxRow({ day: "2026-07-08", business_id: "biz-a", cost_micros: 200_000 }),
        telnyxRow({ day: "2026-07-09", business_id: "biz-a", cost_micros: 100_000 }),
        telnyxRow({ day: "2026-07-08", business_id: "biz-b", cost_micros: 50_000 }),
        telnyxRow({ day: "2026-07-09", business_id: "biz-b", cost_micros: 200_000 })
      ],
      sevenDayWindow
    );
    expect(series.series.map((s) => s.seriesKey)).toEqual(["biz-a", "biz-b"]);
    const spikeDay = series.points.find((p) => p.day === "2026-07-09");
    expect(spikeDay?.segments.map((s) => s.seriesKey)).toEqual(["biz-a", "biz-b"]);
  });

  it("breaks rank ties by business id for stable colors", () => {
    const series = buildTelnyxDailySeries(
      [
        telnyxRow({ day: "2026-07-08", business_id: "biz-b", cost_micros: 70_000 }),
        telnyxRow({ day: "2026-07-09", business_id: "biz-a", cost_micros: 70_000 })
      ],
      sevenDayWindow
    );
    expect(series.series.map((s) => s.seriesKey)).toEqual(["biz-a", "biz-b"]);
  });

  it("folds tenants past the top seven into other, and puts unattributed last", () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      telnyxRow({
        day: "2026-07-10",
        business_id: `biz-${i + 1}`,
        cost_micros: (9 - i) * 10_000
      })
    );
    rows.push(telnyxRow({ day: "2026-07-11", business_id: null, cost_micros: 5_000 }));
    const series = buildTelnyxDailySeries(rows, sevenDayWindow);
    expect(series.series.map((s) => s.seriesKey)).toEqual([
      "biz-1",
      "biz-2",
      "biz-3",
      "biz-4",
      "biz-5",
      "biz-6",
      "biz-7",
      TELNYX_SERIES_OTHER,
      TELNYX_SERIES_UNATTRIBUTED
    ]);
    // Ranks 8 + 9 (20k + 10k) merge into one "other" series and segment.
    expect(series.series[series.series.length - 2]?.totalMicros).toBe(30_000);
    const day = series.points.find((p) => p.day === "2026-07-10");
    expect(day?.segments.filter((s) => s.seriesKey === TELNYX_SERIES_OTHER)).toEqual([
      { seriesKey: TELNYX_SERIES_OTHER, costMicros: 30_000 }
    ]);
  });

  it("omits the other bucket when few tenants exist", () => {
    const series = buildTelnyxDailySeries(
      [
        telnyxRow({ day: "2026-07-10", business_id: "biz-a", cost_micros: 10_000 }),
        telnyxRow({ day: "2026-07-10", business_id: "biz-b", cost_micros: 5_000 })
      ],
      sevenDayWindow
    );
    expect(series.series.map((s) => s.seriesKey)).toEqual(["biz-a", "biz-b"]);
  });

  it("charts an only-unattributed window as a single series", () => {
    const series = buildTelnyxDailySeries(
      [telnyxRow({ day: "2026-07-10", business_id: null, cost_micros: 42_000 })],
      sevenDayWindow
    );
    expect(series.series).toEqual([
      { seriesKey: TELNYX_SERIES_UNATTRIBUTED, totalMicros: 42_000 }
    ]);
    expect(series.points.find((p) => p.day === "2026-07-10")?.segments).toEqual([
      { seriesKey: TELNYX_SERIES_UNATTRIBUTED, costMicros: 42_000 }
    ]);
  });

  it("returns an empty series for zero-cost rows, still zero-filling days", () => {
    const series = buildTelnyxDailySeries(
      [telnyxRow({ day: "2026-07-10", cost_micros: 0, carrier_fee_micros: 0 })],
      sevenDayWindow
    );
    expect(series.series).toEqual([]);
    expect(series.totalMicros).toBe(0);
    expect(series.maxMicros).toBe(0);
    expect(series.points).toHaveLength(7);
    expect(series.points.every((p) => p.costMicros === 0 && p.segments.length === 0)).toBe(
      true
    );
  });
});

describe("buildTelnyxTenantWindowBreakdown", () => {
  const sevenDayWindow = telnyxUsageWindow("7d", NOW);

  it("splits messaging and voice per tenant, summing carrier fees across both", () => {
    const breakdown = buildTelnyxTenantWindowBreakdown(
      [
        telnyxRow({
          day: "2026-07-10",
          cost_micros: 159_000,
          record_count: 10,
          carrier_fee_micros: 30_000
        }),
        telnyxRow({
          day: "2026-07-11",
          record_type: "sip-trunking",
          direction: "inbound",
          cost_micros: 55_000,
          record_count: 3,
          carrier_fee_micros: 5_000,
          billed_seconds: 300
        })
      ],
      sevenDayWindow
    );
    expect(breakdown.totalMicros).toBe(214_000);
    expect(breakdown.hasRows).toBe(true);
    expect(breakdown.tenants).toEqual([
      {
        businessId: "biz-1",
        totalMicros: 214_000,
        carrierFeeMicros: 35_000,
        messagingMicros: 159_000,
        messagingCount: 10,
        voiceMicros: 55_000,
        voiceMinutes: 5,
        sharePct: 100
      }
    ]);
  });

  it("keeps the unattributed row and sorts it by spend like any tenant", () => {
    const breakdown = buildTelnyxTenantWindowBreakdown(
      [
        telnyxRow({ day: "2026-07-10", business_id: null, cost_micros: 900_000 }),
        telnyxRow({ day: "2026-07-10", business_id: "biz-1", cost_micros: 100_000 })
      ],
      sevenDayWindow
    );
    expect(breakdown.tenants.map((t) => t.businessId)).toEqual([null, "biz-1"]);
    expect(breakdown.tenants.map((t) => t.sharePct)).toEqual([90, 10]);
  });

  it("pushes the unattributed row last on ties, whichever side it sorts from", () => {
    const rows = [
      telnyxRow({ day: "2026-07-10", business_id: null, cost_micros: 100_000 }),
      telnyxRow({ day: "2026-07-10", business_id: "biz-1", cost_micros: 100_000 })
    ];
    expect(
      buildTelnyxTenantWindowBreakdown(rows, sevenDayWindow).tenants.map((t) => t.businessId)
    ).toEqual(["biz-1", null]);
    expect(
      buildTelnyxTenantWindowBreakdown([...rows].reverse(), sevenDayWindow).tenants.map(
        (t) => t.businessId
      )
    ).toEqual(["biz-1", null]);
  });

  it("breaks tenant ties by id", () => {
    const breakdown = buildTelnyxTenantWindowBreakdown(
      [
        telnyxRow({ day: "2026-07-10", business_id: "biz-b", cost_micros: 100_000 }),
        telnyxRow({ day: "2026-07-10", business_id: "biz-a", cost_micros: 100_000 })
      ],
      sevenDayWindow
    );
    expect(breakdown.tenants.map((t) => t.businessId)).toEqual(["biz-a", "biz-b"]);
  });

  it("keeps zero-cost volume visible with null shares", () => {
    const breakdown = buildTelnyxTenantWindowBreakdown(
      [telnyxRow({ day: "2026-07-10", cost_micros: 0, carrier_fee_micros: 0, record_count: 15 })],
      sevenDayWindow
    );
    expect(breakdown.totalMicros).toBe(0);
    expect(breakdown.hasRows).toBe(true);
    expect(breakdown.tenants[0]?.messagingCount).toBe(15);
    expect(breakdown.tenants[0]?.sharePct).toBeNull();
  });

  it("filters rows outside the window", () => {
    const breakdown = buildTelnyxTenantWindowBreakdown(
      [
        telnyxRow({ day: "2026-07-05", cost_micros: 999_000 }),
        telnyxRow({ day: "2026-07-13", cost_micros: 999_000 }),
        telnyxRow({ day: "2026-07-10", cost_micros: 10_000 })
      ],
      sevenDayWindow
    );
    expect(breakdown.totalMicros).toBe(10_000);
    expect(breakdown.tenants).toHaveLength(1);
  });

  it("returns an empty breakdown when no rows land in the window", () => {
    expect(buildTelnyxTenantWindowBreakdown([], sevenDayWindow)).toEqual({
      tenants: [],
      totalMicros: 0,
      hasRows: false
    });
  });
});

describe("buildUnattributedSenders", () => {
  it("groups unattributed spend by sender, biggest first, ignoring attributed rows", () => {
    const senders = buildUnattributedSenders([
      telnyxRow({ business_id: "biz-1", sender: null, cost_micros: 9_999_999 }),
      telnyxRow({ business_id: null, sender: "+16028384497", cost_micros: 4_000, record_count: 1 }),
      telnyxRow({ business_id: null, sender: "+16028384497", cost_micros: 28_100, record_count: 1 }),
      telnyxRow({
        business_id: null,
        sender: "new_coworker_jut3q1af_agent",
        cost_micros: 6_500,
        record_count: 3
      })
    ]);
    expect(senders).toEqual([
      { sender: "+16028384497", costMicros: 32_100, recordCount: 2 },
      { sender: "new_coworker_jut3q1af_agent", costMicros: 6_500, recordCount: 3 }
    ]);
  });

  it("keeps rows synced before the sender column last, and breaks ties by sender", () => {
    // Both input orders must land the same way: the unnamed row sorts last
    // whether the comparator meets it as the left or the right operand.
    const rows = [
      telnyxRow({ business_id: null, sender: "+15550002222", cost_micros: 1_000, record_count: 1 }),
      telnyxRow({ business_id: null, sender: "+15550001111", cost_micros: 1_000, record_count: 1 }),
      telnyxRow({ business_id: null, sender: null, cost_micros: 1_000, record_count: 1 })
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      expect(buildUnattributedSenders(ordered).map((s) => s.sender)).toEqual([
        "+15550001111",
        "+15550002222",
        null
      ]);
    }
  });

  it("returns nothing when every row is attributed", () => {
    expect(buildUnattributedSenders([telnyxRow({ business_id: "biz-1" })])).toEqual([]);
  });
});
