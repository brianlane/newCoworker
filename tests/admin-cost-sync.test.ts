import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PLATFORM_COST_SYNC_STATUS_KEY,
  aggregateTelnyxRecords,
  billingCycleMonths,
  buildHostingerSnapshot,
  didSuffix,
  fetchTelnyxDetailRecords,
  parsePlatformCostSyncStatus,
  runPlatformCostSync,
  windowStartDayUtc,
  type PlatformCostSyncDeps,
  type PlatformCostSyncStatus
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
        // Outbound: sender (cli) pays — biz-a, even though cld is biz-b.
        {
          sent_at: "2026-07-10T01:00:00Z",
          direction: "outbound",
          cli: "+16025551111",
          cld: "+16025552222",
          cost: "0.01"
        },
        // Inbound: receiver (cld) pays — biz-b, even though cli is biz-a.
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
      hostingerError: "bang"
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
      hostingerError: null
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
        { businessId: "biz-1", e164: "+1" } // unusable suffix — skipped
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
