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
  listTelnyxCostDaily: vi.fn()
}));

import {
  dedupeSubscriptionsPreferringActive,
  hostingCentsByBusiness,
  hostingSizesByBusiness,
  loadFleetMargins,
  monthStartYmdUtc,
  syncedHostingContradictsPin,
  telnyxMicrosByBusiness
} from "@/lib/admin/margin-data";
import { listBusinesses } from "@/lib/db/businesses";
import { listAllSubscriptions, type SubscriptionRow } from "@/lib/db/subscriptions";
import { listActiveEnterpriseDeals } from "@/lib/db/enterprise-deals";
import { getFleetCalendarMonthUsageByBusiness } from "@/lib/db/usage";
import { getFleetCurrentAiSpendMicrosByBusiness } from "@/lib/db/chat-usage";
import { listHostingerVpsCosts, listTelnyxCostDaily } from "@/lib/db/platform-costs";
import type { HostingerVpsCostRow, TelnyxCostDailyRow } from "@/lib/db/platform-costs";
import { HOSTING_MONTHLY_CENTS_BY_SIZE } from "@/lib/plans/enterprise-pricing";

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
  vi.mocked(listTelnyxCostDaily).mockResolvedValue([
    telnyxRow(),
    telnyxRow({ id: 2, record_type: "sip-trunking", cost_micros: 41_000 }),
    telnyxRow({ id: 3, business_id: null, cost_micros: 999_000 })
  ]);
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

    const data = await loadFleetMargins(NOW);
    expect(data.telnyxActuals).toBe(false);
    const amy = data.byBusiness.get("biz-amy")!;
    expect(amy.lines.find((l) => l.key === "hosting")?.source).toBe("estimate");
    expect(amy.lines.find((l) => l.key === "telnyx_usage")?.source).toBe("estimate");
    expect(amy.lines.find((l) => l.key === "gemini_chat")?.cents).toBe(0);
  });

  it("stringifies non-Error best-effort failures too (logging both shapes)", async () => {
    vi.mocked(getFleetCalendarMonthUsageByBusiness).mockRejectedValue("usage string failure");
    vi.mocked(getFleetCurrentAiSpendMicrosByBusiness).mockRejectedValue(new Error("ai down"));
    vi.mocked(listHostingerVpsCosts).mockRejectedValue("hostinger string failure");
    vi.mocked(listTelnyxCostDaily).mockRejectedValue("telnyx string failure");

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
