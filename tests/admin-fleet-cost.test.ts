import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/admin/margin-data", () => ({
  loadFleetMargins: vi.fn()
}));
vi.mock("@/lib/db/platform-costs", () => ({
  listHostingerVpsCosts: vi.fn(),
  listTelnyxCostDaily: vi.fn()
}));
vi.mock("@/lib/db/vps-inventory", () => ({
  listVpsInventory: vi.fn()
}));

import {
  composeFleetCost,
  loadFleetCostBreakdown,
  trendWindowStartYmd
} from "@/lib/admin/fleet-cost";
import { loadFleetMargins } from "@/lib/admin/margin-data";
import { listHostingerVpsCosts, listTelnyxCostDaily } from "@/lib/db/platform-costs";
import { listVpsInventory } from "@/lib/db/vps-inventory";
import {
  TELNYX_CAMPAIGN_FEE_MONTHLY_CENTS,
  TELNYX_MRC_TAX_RATE,
  TELNYX_USAGE_TAX_RATE,
  TELNYX_VOICE_ADJUNCT_CENTS_PER_MINUTE
} from "@/lib/plans/enterprise-pricing";
import type { MarginLineKey } from "@/lib/admin/margin";

const NOW = new Date("2026-07-12T18:00:00.000Z");

function perTenant(overrides: Partial<Record<MarginLineKey, number>> = {}) {
  return {
    hosting: 0,
    did: 0,
    telnyx_usage: 0,
    gemini_chat: 0,
    stripe_fees: 0,
    ...overrides
  };
}

describe("composeFleetCost", () => {
  /**
   * The reconciliation this module exists for: the fleet total is the
   * per-tenant margin cost PLUS the five platform-level costs no tenant's
   * margin can see. Miss any of them and one admin page disagrees with
   * another, which is exactly what happened before ($450 on the Dashboard
   * vs $434.90 on Revenue, for the same fleet at the same instant).
   */
  it("adds every platform-level cost the per-tenant sums cannot see", () => {
    const result = composeFleetCost({
      marginTotals: {
        revenueCents: 57_300,
        costCents: 10_000,
        marginCents: 47_300,
        marginPct: 82.5,
        payingBusinesses: 3
      },
      perTenantCents: perTenant({ telnyx_usage: 2_000, did: 990 }),
      unattributedTelnyxCents: 100,
      unmodeledStripeFeeCents: 250,
      poolHostingCents: 1_199,
      monthVoiceMinutes: 50
    });

    const voiceAdjunct = Math.round(50 * TELNYX_VOICE_ADJUNCT_CENTS_PER_MINUTE);
    const tax = Math.round(
      (2_000 + 100 + voiceAdjunct) * TELNYX_USAGE_TAX_RATE +
        (990 + TELNYX_CAMPAIGN_FEE_MONTHLY_CENTS) * TELNYX_MRC_TAX_RATE
    );
    expect(result.voiceAdjunctCents).toBe(voiceAdjunct);
    expect(result.telnyxTaxCents).toBe(tax);
    expect(result.campaignFeeCents).toBe(TELNYX_CAMPAIGN_FEE_MONTHLY_CENTS);
    expect(result.totalCostCents).toBe(
      10_000 + 100 + 250 + 1_199 + TELNYX_CAMPAIGN_FEE_MONTHLY_CENTS + voiceAdjunct + tax
    );
    expect(result.netMarginCents).toBe(57_300 - result.totalCostCents);
    // Net is strictly below the per-tenant margin: the extra costs are real.
    expect(result.netMarginCents).toBeLessThan(47_300);
  });

  it("reports net margin as a percentage of revenue", () => {
    const result = composeFleetCost({
      marginTotals: {
        revenueCents: 100_000,
        costCents: 20_000,
        marginCents: 80_000,
        marginPct: 80,
        payingBusinesses: 1
      },
      perTenantCents: perTenant(),
      unattributedTelnyxCents: 0,
      unmodeledStripeFeeCents: 0,
      poolHostingCents: 0,
      monthVoiceMinutes: 0
    });
    expect(result.netMarginPct).toBe(
      Math.round((result.netMarginCents / 100_000) * 1000) / 10
    );
  });

  it("returns a null percentage rather than dividing by zero revenue", () => {
    const result = composeFleetCost({
      marginTotals: {
        revenueCents: 0,
        costCents: 500,
        marginCents: -500,
        marginPct: null,
        payingBusinesses: 0
      },
      perTenantCents: perTenant(),
      unattributedTelnyxCents: 0,
      unmodeledStripeFeeCents: 0,
      poolHostingCents: 0,
      monthVoiceMinutes: 0
    });
    expect(result.netMarginPct).toBeNull();
    expect(result.netMarginCents).toBeLessThan(0);
  });
});

describe("trendWindowStartYmd", () => {
  it("returns the UTC day 90 days back", () => {
    expect(trendWindowStartYmd(NOW)).toBe("2026-04-13");
  });
});

const MARGINS = {
  businesses: [],
  economics: [
    {
      businessId: "biz-1",
      revenueCents: 9_900,
      revenueSource: "subscription" as const,
      lines: [
        { key: "telnyx_usage" as const, label: "t", cents: 400, source: "actual" as const },
        { key: "did" as const, label: "d", cents: 110, source: "estimate" as const }
      ],
      costCents: 510,
      marginCents: 9_390
    }
  ],
  byBusiness: new Map(),
  usageByBusiness: new Map(),
  aiSpendMicrosByBusiness: new Map(),
  subscriptionByBusiness: new Map(),
  totals: {
    revenueCents: 9_900,
    costCents: 510,
    marginCents: 9_390,
    marginPct: 94.8,
    payingBusinesses: 1
  },
  telnyxActuals: true,
  stripeActuals: true,
  unmodeledStripeFeeCents: 250,
  monthStartYmd: "2026-07-01"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadFleetMargins).mockResolvedValue(MARGINS as never);
  vi.mocked(listHostingerVpsCosts).mockResolvedValue([]);
  vi.mocked(listTelnyxCostDaily).mockResolvedValue([
    {
      id: 1,
      day: "2026-07-05",
      business_id: null,
      record_type: "messaging",
      direction: "outbound",
      record_count: 1,
      cost_micros: 1_500_000,
      carrier_fee_micros: 0,
      billed_seconds: 0,
      synced_at: "2026-07-05T00:00:00Z"
    },
    {
      id: 2,
      day: "2026-07-06",
      business_id: "biz-1",
      record_type: "sip-trunking",
      direction: "inbound",
      record_count: 1,
      cost_micros: 10_000,
      carrier_fee_micros: 0,
      billed_seconds: 120,
      synced_at: "2026-07-06T00:00:00Z"
    },
    // Outside the current month: must not reach the month-scoped figures.
    {
      id: 3,
      day: "2026-06-20",
      business_id: null,
      record_type: "messaging",
      direction: "outbound",
      record_count: 1,
      cost_micros: 9_999_000,
      carrier_fee_micros: 0,
      billed_seconds: 6_000,
      synced_at: "2026-06-20T00:00:00Z"
    }
  ] as never);
  vi.mocked(listVpsInventory).mockResolvedValue([]);
});

describe("loadFleetCostBreakdown", () => {
  it("composes the breakdown from this month's rows only", async () => {
    const data = await loadFleetCostBreakdown(NOW);
    expect(vi.mocked(listTelnyxCostDaily)).toHaveBeenCalledWith("2026-04-13");
    // Only the July unattributed row counts (1_500_000 micros = 150 cents);
    // June's much larger row is outside the month window.
    expect(data.breakdown.unattributedTelnyxCents).toBe(150);
    // Voice adjuncts come from July's 120 billed seconds, not June's 6000.
    expect(data.breakdown.voiceAdjunctCents).toBe(
      Math.round((120 / 60) * TELNYX_VOICE_ADJUNCT_CENTS_PER_MINUTE)
    );
    expect(data.breakdown.perTenantCents.telnyx_usage).toBe(400);
    // Stripe fees outside every tenant's modeled line are still real cost.
    expect(data.breakdown.unmodeledStripeFeeCents).toBe(250);
    expect(data.breakdown.revenueCents).toBe(9_900);
    expect(data.telnyxTrendRows).toHaveLength(3);
    expect(data.margins).toBe(MARGINS);
  });

  it("sums idle pool boxes into the fleet cost, ignoring ones that recur nothing", async () => {
    vi.mocked(listVpsInventory).mockResolvedValue([
      {
        vm_id: 900,
        hostname: "pool",
        plan: "kvm1",
        state: "available",
        hostinger_billing_subscription_id: "sub-pool"
      },
      // Cancelled billing: sunk cost until it lapses, so it carries no
      // monthly price and must not inflate the recurring fleet cost.
      {
        vm_id: 901,
        hostname: "pool-lapsing",
        plan: "unparseable",
        state: "available",
        hostinger_billing_subscription_id: "sub-cancelled"
      }
    ] as never);
    vi.mocked(listHostingerVpsCosts).mockResolvedValue([
      {
        subscription_id: "sub-pool",
        vm_id: 900,
        hostname: "pool",
        plan: "KVM 1",
        status: "active",
        billing_period: 1,
        billing_period_unit: "month",
        total_price_cents: 1_199,
        renewal_price_cents: 1_199,
        monthly_price_cents: 1_199,
        is_auto_renewed: true,
        next_billing_at: null,
        expires_at: null,
        assigned_business_id: null,
        snapshot_at: "2026-07-01T00:00:00Z"
      },
      {
        subscription_id: "sub-cancelled",
        vm_id: 901,
        hostname: "pool-lapsing",
        plan: "KVM 1",
        status: "cancelled",
        billing_period: 1,
        billing_period_unit: "month",
        total_price_cents: 1_199,
        renewal_price_cents: 1_199,
        monthly_price_cents: 1_199,
        is_auto_renewed: false,
        next_billing_at: null,
        expires_at: "2026-08-01T00:00:00Z",
        assigned_business_id: null,
        snapshot_at: "2026-07-01T00:00:00Z"
      }
    ] as never);
    const data = await loadFleetCostBreakdown(NOW);
    expect(data.breakdown.poolHostingCents).toBe(1_199);
  });

  /**
   * Every read past the margin load is best effort: an admin page must
   * still render a number when one vendor table is unreadable, rather than
   * erroring out entirely.
   */
  it("degrades each best-effort read to empty instead of throwing", async () => {
    vi.mocked(listHostingerVpsCosts).mockRejectedValue(new Error("hostinger down"));
    vi.mocked(listTelnyxCostDaily).mockRejectedValue("telnyx down");
    vi.mocked(listVpsInventory).mockRejectedValue(new Error("inventory down"));

    const data = await loadFleetCostBreakdown(NOW);
    expect(data.hostingerRows).toEqual([]);
    expect(data.telnyxTrendRows).toEqual([]);
    expect(data.inventory).toEqual([]);
    expect(data.breakdown.unattributedTelnyxCents).toBe(0);
    expect(data.breakdown.poolHostingCents).toBe(0);
    // The per-tenant side survived, so revenue and its costs still report.
    expect(data.breakdown.revenueCents).toBe(9_900);
  });

  it("stringifies non-Error best-effort failures too (logging both shapes)", async () => {
    vi.mocked(listHostingerVpsCosts).mockRejectedValue("hostinger string");
    vi.mocked(listTelnyxCostDaily).mockRejectedValue(new Error("telnyx error"));
    vi.mocked(listVpsInventory).mockRejectedValue("inventory string");

    const data = await loadFleetCostBreakdown(NOW);
    expect(data.hostingerRows).toEqual([]);
    expect(data.telnyxTrendRows).toEqual([]);
    expect(data.inventory).toEqual([]);
  });

  it("defaults `now` to the current time", async () => {
    const data = await loadFleetCostBreakdown();
    expect(vi.mocked(loadFleetMargins)).toHaveBeenCalledTimes(1);
    expect(data.breakdown.totalCostCents).toBeGreaterThan(0);
  });
});
