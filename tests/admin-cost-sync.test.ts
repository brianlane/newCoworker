import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PLATFORM_COST_SYNC_STATUS_KEY,
  STRIPE_FEE_WINDOW_MONTHS,
  aggregateStripeFees,
  aggregateTelnyxRecords,
  billingCycleMonths,
  buildHostingerSnapshot,
  didSuffix,
  fetchTelnyxDetailRecords,
  parsePlatformCostSyncStatus,
  senderLabel,
  runPlatformCostSync,
  stripeCustomerIdFromSource,
  windowStartDayUtc,
  windowStartMonthUtc,
  type PlatformCostSyncDeps,
  type PlatformCostSyncStatus,
  type StripeFeeTransaction
} from "@/lib/admin/cost-sync";
import type { BillingSubscription, VirtualMachine } from "@/lib/hostinger/client";

const NOW = new Date("2026-07-12T18:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function baseDeps(overrides: Partial<PlatformCostSyncDeps> = {}): PlatformCostSyncDeps {
  return {
    telnyxApiKey: "tk",
    fetchImpl: vi.fn(async () => jsonResponse({ data: [] })),
    listBillingSubscriptions: vi.fn(async () => []),
    listVirtualMachines: vi.fn(async () => []),
    listTenantDids: vi.fn(async () => []),
    listBusinessVpsAssignments: vi.fn(async () => []),
    replaceTelnyxCostWindow: vi.fn(async () => {}),
    replaceHostingerVpsCosts: vi.fn(async () => {}),
    listStripeBalanceTransactions: vi.fn(async () => []),
    listStripeCustomerBusinessIds: vi.fn(async () => []),
    replaceStripeFeeWindow: vi.fn(async () => {}),
    recordStatus: vi.fn(async () => {}),
    now: NOW,
    ...overrides
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("didSuffix", () => {
  it("returns the last 10 digits of an E.164 number", () => {
    expect(didSuffix("+16025551234")).toBe("6025551234");
  });

  it("strips formatting characters before slicing", () => {
    expect(didSuffix("(602) 555-1234")).toBe("6025551234");
  });

  it("returns null for numbers shorter than 10 digits", () => {
    expect(didSuffix("+1234")).toBeNull();
  });
});

describe("windowStartDayUtc", () => {
  it("returns the UTC day N days back", () => {
    expect(windowStartDayUtc(NOW, 7)).toBe("2026-07-05");
    expect(windowStartDayUtc(NOW, 90)).toBe("2026-04-13");
  });
});

describe("fetchTelnyxDetailRecords", () => {
  it("returns a single partial page and stops", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse({ data: [{ cost: "1" }] })
    );
    const records = await fetchTelnyxDetailRecords({
      apiKey: "tk",
      recordType: "messaging",
      range: "last_7_days",
      fetchImpl
    });
    expect(records).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toContain(
      "filter[record_type]=messaging"
    );
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toContain(
      "filter[date_range]=last_7_days"
    );
  });

  it("stops at meta.total_pages even when the page is full", async () => {
    const fullPage = Array.from({ length: 250 }, () => ({ cost: "0.01" }));
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: fullPage, meta: { total_pages: 1 } })
    );
    const records = await fetchTelnyxDetailRecords({
      apiKey: "tk",
      recordType: "sip-trunking",
      range: "last_30_days",
      fetchImpl
    });
    expect(records).toHaveLength(250);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps paging past a full page when meta.total_pages is missing", async () => {
    const fullPage = Array.from({ length: 250 }, () => ({ cost: "0.01" }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: fullPage }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ cost: "0.02" }] }));
    const records = await fetchTelnyxDetailRecords({
      apiKey: "tk",
      recordType: "messaging",
      range: "last_90_days",
      fetchImpl
    });
    expect(records).toHaveLength(251);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps paging when the server clamps pages below the requested size", async () => {
    // Telnyx clamps detail_records to 50 rows per page no matter what
    // page[size] asks for, so a short page must not end the pull while
    // meta.total_pages says there is more.
    const clampedPage = Array.from({ length: 50 }, () => ({ cost: "0.01" }));
    const sleepImpl = vi.fn(async () => {});
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse({ data: clampedPage, meta: { total_pages: 3 } })
    );
    const records = await fetchTelnyxDetailRecords({
      apiKey: "tk",
      recordType: "messaging",
      range: "last_90_days",
      fetchImpl,
      sleepImpl
    });
    expect(records).toHaveLength(150);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(vi.mocked(fetchImpl).mock.calls[2][0])).toContain("page[number]=3");
    // Inter-page pacing keeps long pulls under the Telnyx rate limiter.
    expect(sleepImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(350);
  });

  it("stops on an empty page even when meta promises more", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [], meta: { total_pages: 9 } }));
    const records = await fetchTelnyxDetailRecords({
      apiKey: "tk",
      recordType: "messaging",
      range: "last_7_days",
      fetchImpl
    });
    expect(records).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 page with backoff, then succeeds", async () => {
    const sleepImpl = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ cost: "1" }] }));
    const records = await fetchTelnyxDetailRecords({
      apiKey: "tk",
      recordType: "messaging",
      range: "last_7_days",
      fetchImpl,
      sleepImpl
    });
    expect(records).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(1000);
  });

  it("throws once 429 retries are exhausted", async () => {
    const sleepImpl = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => new Response("slow down", { status: 429 }));
    await expect(
      fetchTelnyxDetailRecords({
        apiKey: "tk",
        recordType: "messaging",
        range: "last_7_days",
        fetchImpl,
        sleepImpl
      })
    ).rejects.toThrow(/HTTP 429/);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(sleepImpl).toHaveBeenCalledTimes(5);
  });

  it("aborts past the page cap instead of pulling forever", async () => {
    const clampedPage = Array.from({ length: 50 }, () => ({ cost: "0.01" }));
    const sleepImpl = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: clampedPage, meta: { total_pages: 500 } })
    );
    await expect(
      fetchTelnyxDetailRecords({
        apiKey: "tk",
        recordType: "messaging",
        range: "last_90_days",
        fetchImpl,
        sleepImpl
      })
    ).rejects.toThrow(/exceeded 200 pages/);
    expect(fetchImpl).toHaveBeenCalledTimes(200);
  });

  it("treats a missing data array as an empty page", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const records = await fetchTelnyxDetailRecords({
      apiKey: "tk",
      recordType: "messaging",
      range: "last_7_days",
      fetchImpl
    });
    expect(records).toHaveLength(0);
  });

  it("throws on a non-OK page", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(
      fetchTelnyxDetailRecords({
        apiKey: "bad",
        recordType: "messaging",
        range: "last_7_days",
        fetchImpl
      })
    ).rejects.toThrow(/HTTP 401/);
  });

  it("uses global fetch when no fetchImpl is provided", async () => {
    const stub = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", stub);
    const records = await fetchTelnyxDetailRecords({
      apiKey: "tk",
      recordType: "messaging",
      range: "last_7_days"
    });
    expect(records).toHaveLength(0);
    expect(stub).toHaveBeenCalledTimes(1);
  });
});

describe("aggregateTelnyxRecords", () => {
  const didToBusiness = new Map([["6025551234", "biz-1"]]);

  it("attributes records to a tenant via cli or cld suffix and buckets by day/direction", () => {
    const rows = aggregateTelnyxRecords({
      records: [
        {
          sent_at: "2026-07-10T01:00:00Z",
          direction: "outbound",
          cli: "+16025551234",
          cld: "+14805550000",
          cost: "0.0159",
          carrier_fee: "0.003",
          count: 1
        },
        {
          sent_at: "2026-07-10T02:00:00Z",
          direction: "outbound",
          cli: "+14805550000",
          cld: "+16025551234",
          cost: "0.0159",
          carrier_fee: "0.003",
          count: 2
        },
        {
          sent_at: "2026-07-10T03:00:00Z",
          direction: "inbound",
          cli: "+19995550000",
          cld: "+18885550000",
          cost: "0.0063"
        }
      ],
      recordType: "messaging",
      didToBusiness,
      windowStartDay: "2026-07-05"
    });

    const tenant = rows.find((r) => r.business_id === "biz-1");
    expect(tenant).toMatchObject({
      day: "2026-07-10",
      record_type: "messaging",
      direction: "outbound",
      record_count: 3,
      cost_micros: 31_800,
      carrier_fee_micros: 6_000
    });
    const unattributed = rows.find((r) => r.business_id === null);
    expect(unattributed).toMatchObject({
      direction: "inbound",
      record_count: 1,
      cost_micros: 6_300
    });
  });

  it("prefers the direction-appropriate leg when both legs match tenants", () => {
    const twoTenants = new Map([
      ["6025551111", "biz-a"],
      ["6025552222", "biz-b"]
    ]);
    const rows = aggregateTelnyxRecords({
      records: [
        // Outbound: sender (cli) pays, biz-a, even though cld is biz-b.
        {
          sent_at: "2026-07-10T01:00:00Z",
          direction: "outbound",
          cli: "+16025551111",
          cld: "+16025552222",
          cost: "0.01"
        },
        // Inbound: receiver (cld) pays, biz-b, even though cli is biz-a.
        {
          sent_at: "2026-07-10T02:00:00Z",
          direction: "inbound",
          cli: "+16025551111",
          cld: "+16025552222",
          cost: "0.01"
        },
        // Outbound from an external number TO a tenant: falls back to cld.
        {
          sent_at: "2026-07-10T03:00:00Z",
          direction: "outbound",
          cli: "+19995550000",
          cld: "+16025552222",
          cost: "0.01"
        }
      ],
      recordType: "messaging",
      didToBusiness: twoTenants,
      windowStartDay: "2026-07-05"
    });
    const byBusiness = new Map(rows.map((r) => [`${r.business_id}|${r.direction}`, r]));
    expect(byBusiness.get("biz-a|outbound")?.cost_micros).toBe(10_000);
    expect(byBusiness.get("biz-b|inbound")?.cost_micros).toBe(10_000);
    expect(byBusiness.get("biz-b|outbound")?.cost_micros).toBe(10_000);
  });

  it("drops records before the window start and records with no parseable day", () => {
    const rows = aggregateTelnyxRecords({
      records: [
        { sent_at: "2026-07-01T00:00:00Z", direction: "outbound", cost: "1" },
        { direction: "outbound", cost: "1" },
        { sent_at: "garbage", direction: "outbound", cost: "1" }
      ],
      recordType: "messaging",
      didToBusiness,
      windowStartDay: "2026-07-05"
    });
    expect(rows).toHaveLength(0);
  });

  it("names the sender on unattributed rows, and leaves it null on attributed ones", () => {
    const rows = aggregateTelnyxRecords({
      records: [
        // Attributed: business_id already names the owner.
        {
          sent_at: "2026-07-10T01:00:00Z",
          direction: "outbound",
          cli: "+16025551234",
          cld: "+14805550000",
          cost: "0.004"
        },
        // The international SMS gateway long code: our number, no tenant.
        {
          sent_at: "2026-07-10T02:00:00Z",
          direction: "outbound",
          cli: "+16028384497",
          cld: "+16029226392",
          cost: "0.004"
        },
        // Same sender, second record: one bucket, summed.
        {
          sent_at: "2026-07-10T03:00:00Z",
          direction: "outbound",
          cli: "+16028384497",
          cld: "+16026866672",
          cost: "0.0281"
        },
        // Inbound to an RCS agent id: our leg is cld, and it is not digits,
        // so the DID matcher can never match it.
        {
          sent_at: "2026-07-10T04:00:00Z",
          direction: "inbound",
          cli: "+16026866672",
          cld: "new_coworker_jut3q1af_agent",
          cost: "0.0065"
        }
      ],
      recordType: "messaging",
      didToBusiness,
      windowStartDay: "2026-07-05"
    });
    const bySender = new Map(rows.map((r) => [r.sender, r]));
    expect(bySender.get(null)).toMatchObject({ business_id: "biz-1" });
    expect(bySender.get("+16028384497")).toMatchObject({
      business_id: null,
      record_count: 2,
      cost_micros: 32_100
    });
    expect(bySender.get("new_coworker_jut3q1af_agent")).toMatchObject({
      business_id: null,
      direction: "inbound",
      cost_micros: 6_500
    });
  });

  it("falls back to the other leg for the sender, and to null when both are blank", () => {
    const rows = aggregateTelnyxRecords({
      records: [
        // Telnyx omits cli on some failed records; the peer still identifies it.
        {
          sent_at: "2026-07-10T01:00:00Z",
          direction: "outbound",
          cli: "  ",
          cld: "+16029226392",
          cost: "0.004"
        },
        { sent_at: "2026-07-10T02:00:00Z", direction: "outbound", cost: "0.004" }
      ],
      recordType: "messaging",
      didToBusiness,
      windowStartDay: "2026-07-05"
    });
    expect(rows.map((r) => r.sender)).toEqual(["+16029226392", null]);
  });

  it("falls back through started_at/created_at for voice legs and sums billed seconds", () => {
    const rows = aggregateTelnyxRecords({
      records: [
        {
          started_at: "2026-07-11T00:00:00Z",
          direction: "inbound",
          cli: "+16025551234",
          cost: "0.0035",
          billed_sec: 60
        },
        {
          created_at: "2026-07-11T01:00:00Z",
          direction: "inbound",
          cli: "+16025551234",
          cost: 0.0035,
          billsec: "30"
        },
        {
          created_at: "2026-07-11T02:00:00Z",
          direction: "inbound",
          cli: "+16025551234",
          cost: "0.0035",
          billed_seconds: 15
        }
      ],
      recordType: "sip-trunking",
      didToBusiness,
      windowStartDay: "2026-07-05"
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      business_id: "biz-1",
      record_type: "sip-trunking",
      record_count: 3,
      billed_seconds: 105,
      cost_micros: 10_500
    });
  });

  it("defaults direction to unknown and count to 1; ignores unusable numerics", () => {
    const rows = aggregateTelnyxRecords({
      records: [{ sent_at: "2026-07-11T00:00:00Z", cost: { bogus: true }, count: "x" }],
      recordType: "messaging",
      didToBusiness: new Map(),
      windowStartDay: "2026-07-05"
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: "unknown",
      record_count: 1,
      cost_micros: 0,
      business_id: null
    });
  });
});

describe("billingCycleMonths", () => {
  it("handles month and year units, defaulting an unusable period to 1", () => {
    expect(billingCycleMonths(1, "month")).toBe(1);
    expect(billingCycleMonths(2, "year")).toBe(24);
    expect(billingCycleMonths(undefined, "month")).toBe(1);
    expect(billingCycleMonths(0, "year")).toBe(12);
  });

  it("returns null for unrecognized units", () => {
    expect(billingCycleMonths(1, "fortnight")).toBeNull();
    expect(billingCycleMonths(1, null)).toBeNull();
  });
});

describe("buildHostingerSnapshot", () => {
  const kvm2Sub: BillingSubscription = {
    id: "sub-1",
    status: "active",
    name: "KVM 2",
    billing_period: 1,
    billing_period_unit: "month",
    total_price: 2449,
    renewal_price: 2449,
    is_auto_renewed: true,
    next_billing_at: "2026-08-02T00:00:00Z",
    expires_at: null
  };
  const vm: VirtualMachine = {
    id: 1800980,
    subscription_id: "sub-1",
    plan: "KVM 2",
    hostname: "srv1800980.hstgr.cloud",
    state: "running"
  };

  it("joins subscription → VM → business and derives monthly price", () => {
    const rows = buildHostingerSnapshot({
      subscriptions: [kvm2Sub],
      virtualMachines: [vm],
      assignments: [{ businessId: "biz-1", vmId: 1800980 }]
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subscription_id: "sub-1",
      vm_id: 1800980,
      hostname: "srv1800980.hstgr.cloud",
      plan: "KVM 2",
      monthly_price_cents: 2449,
      assigned_business_id: "biz-1",
      next_billing_at: "2026-08-02T00:00:00Z",
      expires_at: null
    });
  });

  it("divides term prices down to effective monthly cents", () => {
    const rows = buildHostingerSnapshot({
      subscriptions: [
        {
          ...kvm2Sub,
          id: "sub-2yr",
          billing_period: 2,
          billing_period_unit: "year",
          renewal_price: 35_976 // $14.99/mo × 24
        }
      ],
      virtualMachines: [],
      assignments: []
    });
    expect(rows[0].monthly_price_cents).toBe(1499);
    expect(rows[0].vm_id).toBeNull();
    expect(rows[0].hostname).toBeNull();
    expect(rows[0].assigned_business_id).toBeNull();
  });

  it("filters out non-KVM subscriptions and ones with no name", () => {
    const rows = buildHostingerSnapshot({
      subscriptions: [
        { id: "sub-domain", status: "active", name: "Domain .com" },
        { id: "sub-unnamed", status: "active" }
      ],
      virtualMachines: [],
      assignments: []
    });
    expect(rows).toHaveLength(0);
  });

  it("falls back renewal → total price and leaves monthly null when neither exists", () => {
    const rows = buildHostingerSnapshot({
      subscriptions: [
        {
          id: "sub-total-only",
          status: "active",
          name: "KVM 1",
          billing_period: 1,
          billing_period_unit: "month",
          total_price: 1199
        },
        { id: "sub-no-price", status: "non_renewing", name: "KVM 8" }
      ],
      virtualMachines: [],
      assignments: []
    });
    expect(rows[0].monthly_price_cents).toBe(1199);
    expect(rows[0].total_price_cents).toBe(1199);
    expect(rows[0].renewal_price_cents).toBeNull();
    expect(rows[1].monthly_price_cents).toBeNull();
    expect(rows[1].billing_period).toBeNull();
    expect(rows[1].billing_period_unit).toBeNull();
    expect(rows[1].is_auto_renewed).toBeNull();
    expect(rows[1].next_billing_at).toBeNull();
    expect(rows[1].expires_at).toBeNull();
  });

  it("ignores VMs without a subscription id and unassigned VMs resolve business null", () => {
    const rows = buildHostingerSnapshot({
      subscriptions: [kvm2Sub],
      virtualMachines: [
        { id: 42, state: "running" },
        { id: 43, subscription_id: "", state: "running" },
        { ...vm, hostname: undefined }
      ],
      assignments: [{ businessId: "biz-other", vmId: 9999 }]
    });
    expect(rows[0].vm_id).toBe(1800980);
    expect(rows[0].hostname).toBeNull();
    expect(rows[0].assigned_business_id).toBeNull();
  });

  it("refuses to derive a monthly price when the cycle cannot explain the next billing date", () => {
    // VM 1806097 / sub 16BcBrVOTACBI8WdU as Hostinger actually reported it on
    // Aug 26 2026: a one-year period was bought for $155.88, Hostinger moved
    // next_billing_at a year out and left BOTH the cycle ("1 month") and the
    // price ($19.49) stale. 1949/1 = $19.49 would be published as an ACTUAL
    // and overstate this tenant's hosting by $6.50/mo, so publish nothing and
    // let the margin engine use its LABELED SKU estimate instead.
    const rows = buildHostingerSnapshot({
      subscriptions: [
        {
          id: "16BcBrVOTACBI8WdU",
          status: "active",
          name: "KVM 1",
          billing_period: 1,
          billing_period_unit: "month",
          total_price: 1949,
          renewal_price: 1949,
          is_auto_renewed: true,
          next_billing_at: "2027-09-05T04:23:54Z",
          expires_at: null
        }
      ],
      virtualMachines: [],
      assignments: [],
      now: new Date("2026-08-26T12:00:00Z")
    });
    expect(rows[0].monthly_price_cents).toBeNull();
  });

  it("keeps the raw evidence fields when it drops the derived price", () => {
    // Blanking the inputs too would hide the disagreement that the ops
    // finding and the costs page both diagnose from.
    const rows = buildHostingerSnapshot({
      subscriptions: [
        {
          id: "16BcBrVOTACBI8WdU",
          status: "active",
          name: "KVM 1",
          billing_period: 1,
          billing_period_unit: "month",
          total_price: 1949,
          renewal_price: 1949,
          is_auto_renewed: true,
          next_billing_at: "2027-09-05T04:23:54Z",
          expires_at: null
        }
      ],
      virtualMachines: [],
      assignments: [],
      now: new Date("2026-08-26T12:00:00Z")
    });
    expect(rows[0]).toMatchObject({
      billing_period: 1,
      billing_period_unit: "month",
      renewal_price_cents: 1949,
      total_price_cents: 1949,
      next_billing_at: "2027-09-05T04:23:54Z"
    });
  });

  it("still prices a correctly-declared long term", () => {
    // VM 1863856's 2-year term DOES report its period, so nothing is dropped:
    // $359.76 over 24 months is $14.99/mo.
    const rows = buildHostingerSnapshot({
      subscriptions: [
        {
          id: "6olQFVQi75HF2es2",
          status: "active",
          name: "KVM 2",
          billing_period: 2,
          billing_period_unit: "year",
          total_price: 35976,
          renewal_price: 35976,
          is_auto_renewed: true,
          next_billing_at: "2028-07-14T22:43:24Z",
          expires_at: null
        }
      ],
      virtualMachines: [],
      assignments: [],
      now: new Date("2026-08-26T12:00:00Z")
    });
    expect(rows[0].monthly_price_cents).toBe(1499);
  });
});
describe("parsePlatformCostSyncStatus", () => {
  it("returns null for null, non-objects, and missing lastSyncAt", () => {
    expect(parsePlatformCostSyncStatus(null)).toBeNull();
    expect(parsePlatformCostSyncStatus("x")).toBeNull();
    expect(parsePlatformCostSyncStatus({ ok: true })).toBeNull();
  });

  it("round-trips a full status", () => {
    const status: PlatformCostSyncStatus = {
      lastSyncAt: "2026-07-12T18:00:00.000Z",
      ok: false,
      telnyxRange: "last_90_days",
      telnyxRows: 12,
      telnyxError: "boom",
      hostingerRows: 3,
      hostingerError: "bang",
      stripeMonths: 12,
      stripeRows: 5,
      stripeError: "kaboom"
    };
    expect(parsePlatformCostSyncStatus(status)).toEqual(status);
    expect(parsePlatformCostSyncStatus({ ...status, telnyxRange: "last_30_days" })?.telnyxRange).toBe(
      "last_30_days"
    );
  });

  it("defaults unusable fields", () => {
    const parsed = parsePlatformCostSyncStatus({ lastSyncAt: "2026-07-12T18:00:00.000Z" });
    expect(parsed).toEqual({
      lastSyncAt: "2026-07-12T18:00:00.000Z",
      ok: false,
      telnyxRange: "last_7_days",
      telnyxRows: 0,
      telnyxError: null,
      hostingerRows: 0,
      hostingerError: null,
      // A status row written before the Stripe side existed carries none of
      // these keys and must still parse, reading as "nothing synced, no
      // error" rather than blanking the Costs page's whole sync line.
      stripeMonths: 0,
      stripeRows: 0,
      stripeError: null
    });
  });
});

describe("runPlatformCostSync", () => {
  it("skips Telnyx with a recorded error when no API key is configured", async () => {
    const deps = baseDeps({ telnyxApiKey: null });
    const status = await runPlatformCostSync(deps);
    expect(status.ok).toBe(false);
    expect(status.telnyxError).toContain("TELNYX_API_KEY not set");
    expect(deps.replaceTelnyxCostWindow).not.toHaveBeenCalled();
    expect(deps.replaceHostingerVpsCosts).toHaveBeenCalledWith([]);
    expect(deps.recordStatus).toHaveBeenCalledWith(status);
    expect(PLATFORM_COST_SYNC_STATUS_KEY).toBe("platform_cost_sync_status");
  });

  it("aggregates both record types into one window replace", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("record_type]=messaging")) {
        return jsonResponse({
          data: [
            {
              sent_at: "2026-07-10T01:00:00Z",
              direction: "outbound",
              cli: "+16025551234",
              cost: "0.0159",
              count: 1
            }
          ]
        });
      }
      return jsonResponse({
        data: [
          {
            started_at: "2026-07-10T02:00:00Z",
            direction: "inbound",
            cld: "+16025551234",
            cost: "0.0035",
            billed_sec: 60
          }
        ]
      });
    });
    const deps = baseDeps({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      listTenantDids: vi.fn(async () => [
        { businessId: "biz-1", e164: "+16025551234" },
        { businessId: "biz-1", e164: "+1" } // unusable suffix, skipped
      ])
    });
    const status = await runPlatformCostSync(deps);
    expect(status.ok).toBe(true);
    expect(status.telnyxRows).toBe(2);
    expect(deps.replaceTelnyxCostWindow).toHaveBeenCalledWith(
      "2026-07-05",
      expect.arrayContaining([
        expect.objectContaining({ record_type: "messaging", business_id: "biz-1" }),
        expect.objectContaining({ record_type: "sip-trunking", business_id: "biz-1" })
      ])
    );
  });

  it("widens the delete window for a 90-day backfill", async () => {
    const deps = baseDeps();
    const status = await runPlatformCostSync(deps, { telnyxRange: "last_90_days" });
    expect(status.telnyxRange).toBe("last_90_days");
    expect(deps.replaceTelnyxCostWindow).toHaveBeenCalledWith("2026-04-13", []);
  });

  it("records a Telnyx failure without losing the Hostinger snapshot", async () => {
    const deps = baseDeps({
      fetchImpl: vi.fn(async () => new Response("down", { status: 500 })) as unknown as typeof fetch,
      listBillingSubscriptions: vi.fn(async () => [
        { id: "sub-1", status: "active", name: "KVM 2" } as BillingSubscription
      ])
    });
    const status = await runPlatformCostSync(deps);
    expect(status.ok).toBe(false);
    expect(status.telnyxError).toContain("HTTP 500");
    expect(status.hostingerError).toBeNull();
    expect(status.hostingerRows).toBe(1);
    expect(deps.replaceTelnyxCostWindow).not.toHaveBeenCalled();
  });

  it("records a Hostinger failure without losing the Telnyx sync", async () => {
    const deps = baseDeps({
      listBillingSubscriptions: vi.fn(async () => {
        throw new Error("hostinger down");
      })
    });
    const status = await runPlatformCostSync(deps);
    expect(status.telnyxError).toBeNull();
    expect(status.hostingerError).toBe("hostinger down");
    expect(status.ok).toBe(false);
  });

  it("stringifies non-Error failures on both sides", async () => {
    const deps = baseDeps({
      listTenantDids: vi.fn(async () => {
        throw "telnyx-string-failure";
      }),
      listVirtualMachines: vi.fn(async () => {
        throw "hostinger-string-failure";
      })
    });
    const status = await runPlatformCostSync(deps);
    expect(status.telnyxError).toBe("telnyx-string-failure");
    expect(status.hostingerError).toBe("hostinger-string-failure");
  });

  it("defaults `now` to the current time", async () => {
    const deps = baseDeps({ now: undefined });
    const status = await runPlatformCostSync(deps);
    expect(Date.parse(status.lastSyncAt)).toBeGreaterThan(0);
  });
});

describe("senderLabel", () => {
  it("takes the first non-blank leg and trims it", () => {
    expect(senderLabel(["  +16028384497 ", "+16029226392"])).toBe("+16028384497");
    expect(senderLabel(["", "  ", "agent_id"])).toBe("agent_id");
  });

  it("returns null when every leg is blank", () => {
    expect(senderLabel([])).toBeNull();
    expect(senderLabel(["", "   "])).toBeNull();
  });

  it("caps the label so a malformed sender id can't bloat the column", () => {
    expect(senderLabel(["x".repeat(200)])).toHaveLength(64);
  });
});

describe("windowStartMonthUtc", () => {
  it("returns the first of the month N months back, in UTC", () => {
    expect(windowStartMonthUtc(NOW, 12)).toBe("2025-07-01");
    expect(windowStartMonthUtc(NOW, 0)).toBe("2026-07-01");
  });

  it("treats a negative window as zero rather than reaching forward", () => {
    expect(windowStartMonthUtc(NOW, -3)).toBe("2026-07-01");
  });
});

describe("stripeCustomerIdFromSource", () => {
  it("reads the customer from an expanded charge, as a string or an object", () => {
    expect(stripeCustomerIdFromSource({ customer: "cus_1" })).toBe("cus_1");
    expect(stripeCustomerIdFromSource({ customer: { id: "cus_2" } })).toBe("cus_2");
  });

  /**
   * Every "cannot attribute" shape must come back null rather than throw:
   * an unattributable transaction is a normal outcome (account-level fees),
   * not an error.
   */
  it("returns null for every unattributable shape", () => {
    expect(stripeCustomerIdFromSource(null)).toBeNull();
    expect(stripeCustomerIdFromSource("ch_unexpanded")).toBeNull();
    expect(stripeCustomerIdFromSource(undefined)).toBeNull();
    expect(stripeCustomerIdFromSource({})).toBeNull();
    expect(stripeCustomerIdFromSource({ customer: "" })).toBeNull();
    expect(stripeCustomerIdFromSource({ customer: null })).toBeNull();
    expect(stripeCustomerIdFromSource({ customer: { id: "" } })).toBeNull();
    expect(stripeCustomerIdFromSource({ customer: { id: 7 } })).toBeNull();
    expect(stripeCustomerIdFromSource({ customer: 7 })).toBeNull();
  });
});

function txn(overrides: Partial<StripeFeeTransaction> = {}): StripeFeeTransaction {
  return {
    type: "charge",
    amountCents: 28_399,
    feeCents: 1280,
    netCents: 27_119,
    createdUnix: Math.floor(Date.parse("2026-07-05T12:00:00Z") / 1000),
    customerId: "cus_1",
    ...overrides
  };
}

describe("aggregateStripeFees", () => {
  const customerToBusiness = new Map([["cus_1", "biz-1"]]);

  it("buckets per month and tenant, summing gross, fee and net", () => {
    const rows = aggregateStripeFees({
      transactions: [
        txn(),
        txn({ amountCents: 9_900, feeCents: 317, netCents: 9_583 }),
        txn({ createdUnix: Math.floor(Date.parse("2026-06-05T12:00:00Z") / 1000) })
      ],
      customerToBusiness,
      windowStartMonth: "2026-01-01"
    });
    const july = rows.find((r) => r.month_start === "2026-07-01")!;
    expect(july.business_id).toBe("biz-1");
    expect(july.gross_cents).toBe(28_399 + 9_900);
    expect(july.fee_cents).toBe(1280 + 317);
    expect(july.net_cents).toBe(27_119 + 9_583);
    expect(july.charge_count).toBe(2);
    expect(rows.find((r) => r.month_start === "2026-06-01")?.charge_count).toBe(1);
  });

  /**
   * The same unattributed-bucket convention the Telnyx sync uses: a fee we
   * cannot pin to a tenant is real platform cost, not something to drop or
   * to smear across tenants.
   */
  it("files unmatched and customer-less transactions under a null business", () => {
    const rows = aggregateStripeFees({
      transactions: [
        txn({ customerId: "cus_unknown" }),
        txn({ customerId: null, type: "stripe_fee", amountCents: 0, feeCents: 250 })
      ],
      customerToBusiness,
      windowStartMonth: "2026-01-01"
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].business_id).toBeNull();
    expect(rows[0].fee_cents).toBe(1280 + 250);
    // Only the charge carried a fixed per-charge fee.
    expect(rows[0].charge_count).toBe(1);
  });

  it("counts a payment as a charge but a refund as neither", () => {
    const rows = aggregateStripeFees({
      transactions: [
        txn({ type: "payment" }),
        txn({ type: "refund", amountCents: -9_900, feeCents: 0, netCents: -9_900 })
      ],
      customerToBusiness,
      windowStartMonth: "2026-01-01"
    });
    expect(rows[0].charge_count).toBe(1);
    expect(rows[0].gross_cents).toBe(28_399 - 9_900);
  });

  /**
   * The replace only clears months at or after the window start, so a
   * transaction from before it would be inserted ALONGSIDE the row an
   * earlier, wider sync already wrote, double-counting that tenant's fees.
   */
  it("drops transactions settled before the window start", () => {
    const rows = aggregateStripeFees({
      transactions: [txn({ createdUnix: Math.floor(Date.parse("2025-01-05T12:00:00Z") / 1000) })],
      customerToBusiness,
      windowStartMonth: "2026-01-01"
    });
    expect(rows).toEqual([]);
  });

  it("skips transactions with an unusable timestamp", () => {
    const rows = aggregateStripeFees({
      transactions: [
        txn({ createdUnix: Number.NaN }),
        txn({ createdUnix: Number.POSITIVE_INFINITY }),
        txn({ createdUnix: 8.64e15 })
      ],
      customerToBusiness,
      windowStartMonth: "2026-01-01"
    });
    expect(rows).toEqual([]);
  });
});

describe("runPlatformCostSync, Stripe fees", () => {
  it("aggregates and writes the fee window, and reports it in the status", async () => {
    const replaceStripeFeeWindow = vi.fn(async () => {});
    const deps = baseDeps({
      listStripeBalanceTransactions: vi.fn(async () => [
        {
          type: "charge",
          amountCents: 28_399,
          feeCents: 1280,
          netCents: 27_119,
          createdUnix: Math.floor(Date.parse("2026-07-05T12:00:00Z") / 1000),
          customerId: "cus_1"
        }
      ]),
      listStripeCustomerBusinessIds: vi.fn(async () => [
        { businessId: "biz-1", stripeCustomerId: "cus_1" }
      ]),
      replaceStripeFeeWindow
    });
    const status = await runPlatformCostSync(deps);

    expect(status.stripeError).toBeNull();
    expect(status.stripeRows).toBe(1);
    expect(status.stripeMonths).toBe(STRIPE_FEE_WINDOW_MONTHS);
    expect(replaceStripeFeeWindow).toHaveBeenCalledWith("2025-07-01", [
      {
        month_start: "2026-07-01",
        business_id: "biz-1",
        gross_cents: 28_399,
        fee_cents: 1280,
        net_cents: 27_119,
        charge_gross_cents: 28_399,
        charge_fee_cents: 1280,
        charge_count: 1
      }
    ]);
    // The pull starts at the same instant the window does.
    expect(deps.listStripeBalanceTransactions).toHaveBeenCalledWith(
      Math.floor(Date.parse("2025-07-01T00:00:00Z") / 1000)
    );
  });

  it("records a skip (not a crash) when no Stripe key is configured", async () => {
    const deps = baseDeps({ listStripeBalanceTransactions: null });
    const status = await runPlatformCostSync(deps);
    expect(status.ok).toBe(false);
    expect(status.stripeError).toMatch(/STRIPE_SECRET_KEY not set/);
    expect(status.stripeRows).toBe(0);
    expect(deps.replaceStripeFeeWindow).not.toHaveBeenCalled();
  });

  /**
   * The three vendor sides fail independently: a Stripe outage must not
   * cost us the Telnyx or Hostinger pull that already succeeded.
   */
  it("isolates a Stripe failure from the other two sides", async () => {
    const deps = baseDeps({
      listStripeBalanceTransactions: vi.fn(async () => {
        throw new Error("stripe down");
      })
    });
    const status = await runPlatformCostSync(deps);
    expect(status.stripeError).toBe("stripe down");
    expect(status.ok).toBe(false);
    expect(status.telnyxError).toBeNull();
    expect(status.hostingerError).toBeNull();
    expect(deps.replaceTelnyxCostWindow).toHaveBeenCalled();
    expect(deps.replaceHostingerVpsCosts).toHaveBeenCalled();
  });

  it("stringifies a non-Error Stripe failure", async () => {
    const deps = baseDeps({
      listStripeBalanceTransactions: vi.fn(async () => {
        throw "stripe exploded";
      })
    });
    const status = await runPlatformCostSync(deps);
    expect(status.stripeError).toBe("stripe exploded");
  });
});

describe("aggregateStripeFees - charge-only subtotals", () => {
  const customerToBusiness = new Map([["cus_1", "biz-1"]]);

  /**
   * Stripe does NOT return the fee when a charge is refunded. Folding a
   * refund into the rate inputs lowers gross while the fee stands still, so
   * the derived rate reads high while still looking plausible enough to be
   * published as `calibrated`. The charge-only subtotals are what keeps a
   * refund out of the rate; the unrestricted totals still carry it so they
   * reconcile against Stripe's own net volume.
   */
  it("keeps refunds out of the rate inputs but inside the reconciling totals", () => {
    const rows = aggregateStripeFees({
      transactions: [
        txn(),
        txn({ type: "refund", amountCents: -10_000, feeCents: 0, netCents: -10_000 })
      ],
      customerToBusiness,
      windowStartMonth: "2026-01-01"
    });
    const row = rows[0];
    // Totals carry everything, so they still match Stripe's net volume.
    expect(row.gross_cents).toBe(28_399 - 10_000);
    expect(row.net_cents).toBe(27_119 - 10_000);
    // Rate inputs see only the charge.
    expect(row.charge_gross_cents).toBe(28_399);
    expect(row.charge_fee_cents).toBe(1280);
    expect(row.charge_count).toBe(1);
  });

  it("excludes non-charge fees (account level, disputes) from the rate inputs", () => {
    const rows = aggregateStripeFees({
      transactions: [txn(), txn({ type: "adjustment", amountCents: 0, feeCents: 1_500 })],
      customerToBusiness,
      windowStartMonth: "2026-01-01"
    });
    expect(rows[0].fee_cents).toBe(1280 + 1_500);
    expect(rows[0].charge_fee_cents).toBe(1280);
  });
});
