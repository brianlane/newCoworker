import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/businesses", () => ({
  listBusinesses: vi.fn()
}));
vi.mock("@/lib/db/subscriptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/subscriptions")>();
  return {
    ...actual,
    listAllSubscriptions: vi.fn()
  };
});
vi.mock("@/lib/db/enterprise-deals", () => ({
  listActiveEnterpriseDeals: vi.fn()
}));
vi.mock("@/lib/db/usage", () => ({
  getFleetCalendarMonthUsageByBusiness: vi.fn()
}));
vi.mock("@/lib/db/chat-usage", () => ({
  getFleetCurrentAiSpendMicrosByBusiness: vi.fn()
}));
vi.mock("@/lib/db/platform-costs", () => ({
  listHostingerVpsCosts: vi.fn(),
  listTelnyxCostDaily: vi.fn(),
  listTenantDids: vi.fn(),
  listStripeFeeMonthly: vi.fn()
}));

import {
  dedupeSubscriptionsPreferringActive,
  hostingCentsByBusiness,
  hostingSizesByBusiness,
  loadFleetMargins,
  monthStartYmdUtc,
  stripeObservedByBusiness,
  unmodeledStripeFeeCents,
  syncedHostingContradictsPin,
  telnyxMicrosByBusiness,
  didCountByBusiness
} from "@/lib/admin/margin-data";
import { listBusinesses } from "@/lib/db/businesses";
import { listAllSubscriptions, type SubscriptionRow } from "@/lib/db/subscriptions";
import { listActiveEnterpriseDeals } from "@/lib/db/enterprise-deals";
import { getFleetCalendarMonthUsageByBusiness } from "@/lib/db/usage";
import { getFleetCurrentAiSpendMicrosByBusiness } from "@/lib/db/chat-usage";
import {
  listHostingerVpsCosts,
  listStripeFeeMonthly,
  listTelnyxCostDaily,
  listTenantDids
} from "@/lib/db/platform-costs";
import type {
  HostingerVpsCostRow,
  StripeFeeMonthlyRow,
  TelnyxCostDailyRow
} from "@/lib/db/platform-costs";
import {
  ENTERPRISE_UNIT_COSTS,
  HOSTING_MONTHLY_CENTS_BY_SIZE
} from "@/lib/plans/enterprise-pricing";

const NOW = new Date("2026-07-12T18:00:00.000Z");

const AMY = {
  id: "biz-amy",
  name: "Amy Laidlaw Real Estate",
  owner_email: "amy@example.com",
  tier: "standard" as const,
  status: "online" as const,
  hostinger_vps_id: "1800980",
  vps_size: "kvm2" as const,
  vps_provider: "hostinger" as const,
  created_at: "2026-01-01T00:00:00.000Z"
};

const PILOT = {
  id: "biz-pilot",
  name: "Residency Pilot",
  owner_email: "pilot@example.com",
  tier: "enterprise" as const,
  status: "online" as const,
  hostinger_vps_id: "1900000",
  created_at: "2026-06-01T00:00:00.000Z"
};

const AMY_SUB = {
  id: "sub-row",
  business_id: "biz-amy",
  tier: "standard" as const,
  status: "active" as const,
  stripe_subscription_id: "sub_stripe",
  billing_period: "biennial" as const,
  renewal_at: "2028-01-01T00:00:00.000Z",
  stripe_current_period_start: "2026-01-01T00:00:00.000Z",
  stripe_current_period_end: "2028-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z"
};

const HOSTINGER_ROW: HostingerVpsCostRow = {
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
  assigned_business_id: "biz-amy",
  snapshot_at: "2026-07-12T11:10:00.000Z"
};

function telnyxRow(overrides: Partial<TelnyxCostDailyRow> = {}): TelnyxCostDailyRow {
  return {
    id: 1,
    day: "2026-07-10",
    business_id: "biz-amy",
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listBusinesses).mockResolvedValue([AMY, PILOT] as never);
  vi.mocked(listAllSubscriptions).mockResolvedValue([AMY_SUB] as never);
  vi.mocked(listActiveEnterpriseDeals).mockResolvedValue([
    { business_id: "biz-pilot", monthly_cents: 250_000 }
  ] as never);
  vi.mocked(getFleetCalendarMonthUsageByBusiness).mockResolvedValue(
    new Map([
      ["biz-amy", { smsSent: 251, voiceMinutes: 31, callsMade: 12, peakConcurrentCalls: 2 }]
    ])
  );
  vi.mocked(getFleetCurrentAiSpendMicrosByBusiness).mockResolvedValue(
    new Map([["biz-amy", 410_000]])
  );
  vi.mocked(listHostingerVpsCosts).mockResolvedValue([HOSTINGER_ROW]);
  vi.mocked(listTenantDids).mockResolvedValue([
    { businessId: "biz-amy", e164: "+16028053377" }
  ]);
  vi.mocked(listTelnyxCostDaily).mockResolvedValue([
    telnyxRow(),
    telnyxRow({ id: 2, record_type: "sip-trunking", cost_micros: 41_000 }),
    telnyxRow({ id: 3, business_id: null, cost_micros: 999_000 })
  ]);
  vi.mocked(listStripeFeeMonthly).mockResolvedValue([]);
});

describe("monthStartYmdUtc", () => {
  it("returns the first of the current UTC month", () => {
    expect(monthStartYmdUtc(NOW)).toBe("2026-07-01");
  });
});

describe("dedupeSubscriptionsPreferringActive", () => {
  function sub(overrides: Partial<SubscriptionRow>): SubscriptionRow {
    return { ...AMY_SUB, ...overrides } as SubscriptionRow;
  }

  it("lets an older ACTIVE row win over a newer pending resubscribe (newest-first input)", () => {
    const pending = sub({ id: "sub-pending", status: "pending" });
    const active = sub({ id: "sub-active" });
    const map = dedupeSubscriptionsPreferringActive([pending, active]);
    expect(map.get("biz-amy")?.id).toBe("sub-active");
  });

  it("keeps the newest active row when several are active", () => {
    const newerActive = sub({ id: "sub-newer" });
    const olderActive = sub({ id: "sub-older" });
    const map = dedupeSubscriptionsPreferringActive([newerActive, olderActive]);
    expect(map.get("biz-amy")?.id).toBe("sub-newer");
  });

  it("falls back to the newest row of any status when nothing is active", () => {
    const canceledNewest = sub({ id: "sub-canceled", status: "canceled" });
    const stripelessActive = sub({
      id: "sub-stripeless",
      status: "active",
      stripe_subscription_id: null
    });
    const map = dedupeSubscriptionsPreferringActive([canceledNewest, stripelessActive]);
    // Stripe-less "active" is not revenue-bearing; the newest row stands.
    expect(map.get("biz-amy")?.id).toBe("sub-canceled");
  });
});

describe("hostingCentsByBusiness", () => {
  it("sums per business, skipping unassigned/unpriced/cancelled rows", () => {
    const map = hostingCentsByBusiness([
      HOSTINGER_ROW,
      { ...HOSTINGER_ROW, subscription_id: "sub-2", monthly_price_cents: 1499 },
      { ...HOSTINGER_ROW, subscription_id: "sub-3", assigned_business_id: null },
      { ...HOSTINGER_ROW, subscription_id: "sub-4", monthly_price_cents: null },
      // Cancelled = sunk cost until lapse, not recurring hosting spend.
      { ...HOSTINGER_ROW, subscription_id: "sub-5", status: "cancelled" }
    ]);
    expect(map.get("biz-amy")).toBe(2449 + 1499);
    expect(map.size).toBe(1);
  });
});

describe("hostingSizesByBusiness", () => {
  it("collects parseable sizes per business under the same row filter as the cents map", () => {
    const map = hostingSizesByBusiness([
      HOSTINGER_ROW, // KVM 2
      { ...HOSTINGER_ROW, subscription_id: "sub-2", plan: "KVM 8" },
      { ...HOSTINGER_ROW, subscription_id: "sub-3", plan: "Mystery SKU" }, // unparseable → skipped
      { ...HOSTINGER_ROW, subscription_id: "sub-4", assigned_business_id: null },
      { ...HOSTINGER_ROW, subscription_id: "sub-5", monthly_price_cents: null },
      { ...HOSTINGER_ROW, subscription_id: "sub-6", status: "cancelled" }
    ]);
    expect(map.get("biz-amy")).toEqual(["kvm2", "kvm8"]);
    expect(map.size).toBe(1);
  });
});

describe("syncedHostingContradictsPin", () => {
  it("is false without a valid pin or without synced sizes", () => {
    expect(syncedHostingContradictsPin(null, ["kvm8"])).toBe(false);
    expect(syncedHostingContradictsPin("weird", ["kvm8"])).toBe(false);
    expect(syncedHostingContradictsPin("kvm2", undefined)).toBe(false);
    expect(syncedHostingContradictsPin("kvm2", [])).toBe(false);
  });

  it("is false when every synced box matches the pin", () => {
    expect(syncedHostingContradictsPin("kvm2", ["kvm2", "kvm2"])).toBe(false);
  });

  it("is true when any synced box disagrees with the pin", () => {
    expect(syncedHostingContradictsPin("kvm2", ["kvm8"])).toBe(true);
    expect(syncedHostingContradictsPin("kvm2", ["kvm2", "kvm8"])).toBe(true);
  });
});

describe("telnyxMicrosByBusiness", () => {
  it("sums cost per business, excluding unattributed rows", () => {
    const map = telnyxMicrosByBusiness([
      telnyxRow(),
      telnyxRow({ id: 2, cost_micros: 41_000 }),
      telnyxRow({ id: 3, business_id: null })
    ]);
    expect(map.get("biz-amy")).toBe(200_000);
    expect(map.size).toBe(1);
  });
});

describe("loadFleetMargins", () => {
  it("assembles synced actuals + usage into per-business economics", async () => {
    const data = await loadFleetMargins(NOW);
    expect(vi.mocked(listTelnyxCostDaily)).toHaveBeenCalledWith("2026-07-01");
    expect(data.telnyxActuals).toBe(true);
    expect(data.monthStartYmd).toBe("2026-07-01");

    const amy = data.byBusiness.get("biz-amy")!;
    expect(amy.revenueSource).toBe("subscription");
    expect(amy.lines.find((l) => l.key === "hosting")).toMatchObject({
      cents: 2449,
      source: "actual"
    });
    expect(amy.lines.find((l) => l.key === "telnyx_usage")).toMatchObject({
      cents: 20, // 200,000 micro-USD
      source: "actual"
    });
    expect(amy.lines.find((l) => l.key === "gemini_chat")?.cents).toBe(41);

    // Enterprise pilot: deal revenue; synced Telnyx present fleet-wide, so
    // its zero rows read as actual $0, not an estimate.
    const pilot = data.byBusiness.get("biz-pilot")!;
    expect(pilot.revenueSource).toBe("enterprise_deal");
    expect(pilot.revenueCents).toBe(250_000);
    expect(pilot.lines.find((l) => l.key === "telnyx_usage")).toMatchObject({
      cents: 0,
      source: "actual"
    });
    // Pilot has no vps_size/vps_provider fields at all — estimate fallbacks.
    expect(pilot.lines.find((l) => l.key === "hosting")?.source).toBe("estimate");

    expect(data.totals.revenueCents).toBe(amy.revenueCents + pilot.revenueCents);
    expect(data.economics).toHaveLength(2);
    expect(data.businesses).toHaveLength(2);
    expect(data.usageByBusiness.get("biz-amy")?.smsSent).toBe(251);
    expect(data.aiSpendMicrosByBusiness.get("biz-amy")).toBe(410_000);
  });

  it("replaces the synced price with the pinned SKU when the box size contradicts the pin", async () => {
    // Scar Fairy scenario: standard tenant pinned kvm2, but the assigned
    // (lapsing) billing row is still the old KVM8 at $73.99 — the margin
    // must reflect the pinned kvm2 SKU, not the outgoing box's bill.
    vi.mocked(listHostingerVpsCosts).mockResolvedValue([
      { ...HOSTINGER_ROW, plan: "KVM 8", monthly_price_cents: 7399, status: "non_renewing" }
    ]);
    const data = await loadFleetMargins(NOW);
    const amy = data.byBusiness.get("biz-amy")!;
    expect(amy.lines.find((l) => l.key === "hosting")).toMatchObject({
      cents: HOSTING_MONTHLY_CENTS_BY_SIZE.kvm2,
      source: "estimate"
    });
  });

  it("keeps the synced price when the box size matches the pin (promo pricing wins)", async () => {
    vi.mocked(listHostingerVpsCosts).mockResolvedValue([
      { ...HOSTINGER_ROW, monthly_price_cents: 1899 } // KVM 2 promo below SKU
    ]);
    const data = await loadFleetMargins(NOW);
    const amy = data.byBusiness.get("biz-amy")!;
    expect(amy.lines.find((l) => l.key === "hosting")).toMatchObject({
      cents: 1899,
      source: "actual"
    });
  });

  it("degrades every best-effort read to estimates/zeroes", async () => {
    vi.mocked(getFleetCalendarMonthUsageByBusiness).mockRejectedValue(new Error("usage down"));
    vi.mocked(getFleetCurrentAiSpendMicrosByBusiness).mockRejectedValue("ai down");
    vi.mocked(listHostingerVpsCosts).mockRejectedValue(new Error("hostinger down"));
    vi.mocked(listTelnyxCostDaily).mockRejectedValue(new Error("telnyx down"));
    vi.mocked(listTenantDids).mockRejectedValue(new Error("dids down"));

    const data = await loadFleetMargins(NOW);
    expect(data.telnyxActuals).toBe(false);
    const amy = data.byBusiness.get("biz-amy")!;
    // An unreadable DID list must not zero the number-rental line: it falls
    // back to the old one-DID-per-live-box heuristic.
    expect(amy.lines.find((l) => l.key === "did")?.cents).toBe(
      ENTERPRISE_UNIT_COSTS.didMonthlyCents
    );
    expect(amy.lines.find((l) => l.key === "hosting")?.source).toBe("estimate");
    expect(amy.lines.find((l) => l.key === "telnyx_usage")?.source).toBe("estimate");
    expect(amy.lines.find((l) => l.key === "gemini_chat")?.cents).toBe(0);
  });

  it("stringifies non-Error best-effort failures too (logging both shapes)", async () => {
    vi.mocked(getFleetCalendarMonthUsageByBusiness).mockRejectedValue("usage string failure");
    vi.mocked(getFleetCurrentAiSpendMicrosByBusiness).mockRejectedValue(new Error("ai down"));
    vi.mocked(listHostingerVpsCosts).mockRejectedValue("hostinger string failure");
    vi.mocked(listTelnyxCostDaily).mockRejectedValue("telnyx string failure");
    vi.mocked(listTenantDids).mockRejectedValue("dids string failure");

    const data = await loadFleetMargins(NOW);
    expect(data.telnyxActuals).toBe(false);
    expect(data.usageByBusiness.size).toBe(0);
    expect(data.aiSpendMicrosByBusiness.size).toBe(0);
  });

  it("treats an empty Telnyx table as unsynced (estimates, not actual zeroes)", async () => {
    vi.mocked(listTelnyxCostDaily).mockResolvedValue([]);
    const data = await loadFleetMargins(NOW);
    expect(data.telnyxActuals).toBe(false);
    expect(data.byBusiness.get("biz-amy")!.lines.find((l) => l.key === "telnyx_usage")?.source).toBe(
      "estimate"
    );
  });

  it("defaults `now` to the current time", async () => {
    const data = await loadFleetMargins();
    expect(data.monthStartYmd).toBe(monthStartYmdUtc());
  });
});

describe("didCountByBusiness", () => {
  it("counts DISTINCT numbers, so the SMS + voice-route join can't double a rental", () => {
    const counts = didCountByBusiness([
      { businessId: "biz-amy", e164: "+16028053377" },
      { businessId: "biz-amy", e164: "+16028053377" }, // same number, voice route
      { businessId: "biz-kyp", e164: "+14388035806" },
      { businessId: "biz-kyp", e164: "+15198006401" }
    ]);
    expect(counts.get("biz-amy")).toBe(1);
    expect(counts.get("biz-kyp")).toBe(2);
  });

  it("returns an empty map for no DIDs", () => {
    expect(didCountByBusiness([]).size).toBe(0);
  });
});

describe("loadFleetMargins: DID rentals follow the numbers, not the boxes", () => {
  it("charges a box-less tenant for the number it rents", async () => {
    // PILOT has no Hostinger box; give it a DID and it must still cost.
    vi.mocked(listTenantDids).mockResolvedValue([
      { businessId: "biz-pilot", e164: "+15198006401" }
    ]);
    const data = await loadFleetMargins(NOW);
    expect(data.byBusiness.get("biz-pilot")!.lines.find((l) => l.key === "did")?.cents).toBe(
      ENTERPRISE_UNIT_COSTS.didMonthlyCents
    );
    // Amy has a box but rents nothing here, so she carries no DID line.
    expect(data.byBusiness.get("biz-amy")!.lines.find((l) => l.key === "did")).toBeUndefined();
  });
});

function stripeFeeRow(overrides: Partial<StripeFeeMonthlyRow> = {}): StripeFeeMonthlyRow {
  return {
    id: 1,
    month_start: "2026-07-01",
    business_id: "biz-amy",
    gross_cents: 28_399,
    fee_cents: 1280,
    net_cents: 27_119,
    charge_gross_cents: 28_399,
    charge_fee_cents: 1280,
    charge_count: 1,
    synced_at: "2026-07-06T00:00:00Z",
    ...overrides
  };
}

describe("stripeObservedByBusiness", () => {
  /**
   * Rates are derived from ALL retained months, not just the current one: a
   * biennial tenant is charged once every 24 months, so a single-month read
   * would leave exactly the largest charges unobserved.
   */
  it("sums every retained month per business", () => {
    const map = stripeObservedByBusiness([
      stripeFeeRow(),
      stripeFeeRow({
        id: 2,
        month_start: "2026-06-01",
        gross_cents: 9_900,
        fee_cents: 317,
        charge_gross_cents: 9_900,
        charge_fee_cents: 317,
        charge_count: 1
      })
    ]);
    expect(map.get("biz-amy")).toEqual({
      grossCents: 38_299,
      feeCents: 1_597,
      chargeCount: 2
    });
  });

  /**
   * The rate must come from the charge-only columns. A month whose totals
   * were dented by a refund (smaller gross, unchanged fee) would otherwise
   * derive a rate that reads high while still looking plausible.
   */
  it("reads the charge-only columns, not the refund-dented totals", () => {
    const map = stripeObservedByBusiness([
      stripeFeeRow({ gross_cents: 18_399, fee_cents: 1280, net_cents: 17_119 })
    ]);
    expect(map.get("biz-amy")).toEqual({
      grossCents: 28_399,
      feeCents: 1280,
      chargeCount: 1
    });
  });

  it("excludes unattributed rows, which belong to no tenant's rate", () => {
    const map = stripeObservedByBusiness([
      stripeFeeRow(),
      stripeFeeRow({ id: 2, business_id: null, fee_cents: 5_000 })
    ]);
    expect(map.get("biz-amy")!.feeCents).toBe(1280);
    expect(map.size).toBe(1);
  });
});

describe("loadFleetMargins, Stripe fee observation", () => {
  it("reads a wide history window and calibrates the fee line from it", async () => {
    vi.mocked(listStripeFeeMonthly).mockResolvedValue([stripeFeeRow()]);
    const data = await loadFleetMargins(NOW);
    expect(vi.mocked(listStripeFeeMonthly)).toHaveBeenCalledWith("2023-07-01");
    expect(data.stripeActuals).toBe(true);
    const feeLine = data.byBusiness.get("biz-amy")!.lines.find((l) => l.key === "stripe_fees")!;
    expect(feeLine.source).toBe("calibrated");
  });

  /**
   * Unlike Telnyx, "no rows" is NOT an actual zero: a term tenant may
   * simply not have been charged inside the retained history, so the fee
   * line must fall back to the country estimate rather than deriving a rate
   * from nothing.
   */
  it("falls back to the estimate when no fee rows exist", async () => {
    vi.mocked(listStripeFeeMonthly).mockResolvedValue([]);
    const data = await loadFleetMargins(NOW);
    expect(data.stripeActuals).toBe(false);
    const feeLine = data.byBusiness.get("biz-amy")!.lines.find((l) => l.key === "stripe_fees")!;
    expect(feeLine.source).toBe("estimate");
  });

  it("degrades a failed fee read to estimates instead of erroring", async () => {
    vi.mocked(listStripeFeeMonthly).mockRejectedValue(new Error("stripe fee read failed"));
    const data = await loadFleetMargins(NOW);
    expect(data.stripeActuals).toBe(false);
    expect(data.byBusiness.get("biz-amy")!.revenueCents).toBeGreaterThan(0);
  });

  it("stringifies a non-Error fee-read failure too", async () => {
    vi.mocked(listStripeFeeMonthly).mockRejectedValue("stripe fee read exploded");
    const data = await loadFleetMargins(NOW);
    expect(data.stripeActuals).toBe(false);
  });

  /**
   * The estimate's fallback signal is the tenant's own country, resolved
   * from their phone/timezone: a Canadian tenant's card is very likely
   * non-US, and pricing them at the domestic 2.9% understates the fee.
   */
  it("resolves the fallback rate from the tenant's phone and timezone", async () => {
    vi.mocked(listStripeFeeMonthly).mockResolvedValue([]);
    vi.mocked(listBusinesses).mockResolvedValue([
      { ...AMY, phone: "+16045551234", timezone: "America/Vancouver" },
      PILOT
    ] as never);
    const canadian = await loadFleetMargins(NOW);

    vi.mocked(listBusinesses).mockResolvedValue([AMY, PILOT] as never);
    const american = await loadFleetMargins(NOW);

    const feeOf = (data: Awaited<ReturnType<typeof loadFleetMargins>>) =>
      data.byBusiness.get("biz-amy")!.lines.find((l) => l.key === "stripe_fees")!.cents;
    expect(feeOf(canadian)).toBeGreaterThan(feeOf(american));
  });
});

describe("unmodeledStripeFeeCents", () => {
  /**
   * Account-level Stripe fees belong to no tenant, but they are still money
   * Stripe took: they were being stored and then dropped from every fleet
   * total, the same way the Telnyx leak bucket would have been.
   */
  it("counts every cent of a tenant-less row, this month only", () => {
    const rows = [
      stripeFeeRow({ id: 1, business_id: null, fee_cents: 250, charge_fee_cents: 0 }),
      stripeFeeRow({ id: 2, business_id: null, fee_cents: 400, charge_fee_cents: 0 }),
      // Previous month: outside the current fleet total.
      stripeFeeRow({
        id: 4,
        business_id: null,
        month_start: "2026-06-01",
        fee_cents: 5_000,
        charge_fee_cents: 0
      })
    ];
    expect(unmodeledStripeFeeCents(rows, "2026-07-01")).toBe(650);
  });

  /**
   * A tenant's margin line is a rate derived from the charge-only columns,
   * so it represents charge_fee_cents and nothing else. A dispute Stripe
   * attaches to that customer sits above it in fee_cents, inside no rate
   * and inside no leak bucket, and would otherwise vanish from every fleet
   * total. Only the remainder is counted, so the charge fees a tenant line
   * DOES model are not double-counted.
   */
  it("counts an attributed row's non-charge remainder, not its charge fees", () => {
    const rows = [
      stripeFeeRow({
        id: 1,
        business_id: "biz-amy",
        fee_cents: 1280 + 1_500, // card fee plus a dispute
        charge_fee_cents: 1280
      })
    ];
    expect(unmodeledStripeFeeCents(rows, "2026-07-01")).toBe(1_500);
  });

  it("counts nothing extra for an ordinary all-charges tenant month", () => {
    const rows = [
      stripeFeeRow({ id: 1, business_id: "biz-amy", fee_cents: 1280, charge_fee_cents: 1280 })
    ];
    expect(unmodeledStripeFeeCents(rows, "2026-07-01")).toBe(0);
  });
});
