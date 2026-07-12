import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listBusinessVpsAssignments,
  listHostingerVpsCosts,
  listTelnyxCostDaily,
  listTenantDids,
  replaceHostingerVpsCosts,
  replaceTelnyxCostWindow,
  type HostingerVpsCostInsert,
  type TelnyxCostDailyInsert
} from "@/lib/db/platform-costs";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type MockResponse = { data: unknown; error: { message: string } | null };

/**
 * Query-builder mock: each `.from()` consumes the next configured response;
 * every chained method records itself and returns the same thenable
 * builder, so any await point in the chain resolves that response.
 */
function mockClient(responses: MockResponse[]) {
  let next = 0;
  const calls: Array<{ table: string; ops: Array<{ method: string; args: unknown[] }> }> = [];
  const client = {
    from(table: string) {
      const response = responses[Math.min(next, responses.length - 1)];
      next += 1;
      const record = { table, ops: [] as Array<{ method: string; args: unknown[] }> };
      calls.push(record);
      const builder: Record<string, unknown> = {
        then(
          onFulfilled?: (value: MockResponse) => unknown,
          onRejected?: (reason: unknown) => unknown
        ) {
          return Promise.resolve(response).then(onFulfilled, onRejected);
        }
      };
      for (const method of [
        "select",
        "insert",
        "delete",
        "eq",
        "neq",
        "not",
        "gte",
        "order",
        "range"
      ]) {
        builder[method] = (...args: unknown[]) => {
          record.ops.push({ method, args });
          return builder;
        };
      }
      return builder;
    }
  };
  return { client: client as never, calls };
}

const TELNYX_ROW: TelnyxCostDailyInsert = {
  day: "2026-07-10",
  business_id: "biz-1",
  record_type: "messaging",
  direction: "outbound",
  record_count: 3,
  cost_micros: 31_800,
  carrier_fee_micros: 6_000,
  billed_seconds: 0
};

const HOSTINGER_ROW: HostingerVpsCostInsert = {
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
  next_billing_at: "2026-08-02T00:00:00Z",
  expires_at: null,
  assigned_business_id: "biz-1"
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("replaceTelnyxCostWindow", () => {
  it("deletes the window then inserts the fresh rows", async () => {
    const { client, calls } = mockClient([{ data: null, error: null }]);
    await replaceTelnyxCostWindow("2026-07-05", [TELNYX_ROW], client);
    expect(calls[0].ops).toEqual([
      { method: "delete", args: [] },
      { method: "gte", args: ["day", "2026-07-05"] }
    ]);
    expect(calls[1].ops[0]).toEqual({ method: "insert", args: [[TELNYX_ROW]] });
  });

  it("skips the insert when there are no rows", async () => {
    const { client, calls } = mockClient([{ data: null, error: null }]);
    await replaceTelnyxCostWindow("2026-07-05", [], client);
    expect(calls).toHaveLength(1);
  });

  it("throws on delete and insert errors", async () => {
    const del = mockClient([{ data: null, error: { message: "boom" } }]);
    await expect(replaceTelnyxCostWindow("2026-07-05", [TELNYX_ROW], del.client)).rejects.toThrow(
      /delete: boom/
    );
    const ins = mockClient([
      { data: null, error: null },
      { data: null, error: { message: "bang" } }
    ]);
    await expect(replaceTelnyxCostWindow("2026-07-05", [TELNYX_ROW], ins.client)).rejects.toThrow(
      /insert: bang/
    );
  });

  it("falls back to the service client when none is provided", async () => {
    const { client } = mockClient([{ data: null, error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    await replaceTelnyxCostWindow("2026-07-05", [], client);
    await replaceTelnyxCostWindow("2026-07-05", []);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("listTelnyxCostDaily", () => {
  it("pages through full pages and concatenates", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ ...TELNYX_ROW, id: i + 1 }));
    const { client } = mockClient([
      { data: fullPage, error: null },
      { data: [{ ...TELNYX_ROW, id: 1001 }], error: null }
    ]);
    const rows = await listTelnyxCostDaily("2026-07-01", client);
    expect(rows).toHaveLength(1001);
  });

  it("handles a null data page and throws on error", async () => {
    const empty = mockClient([{ data: null, error: null }]);
    expect(await listTelnyxCostDaily("2026-07-01", empty.client)).toEqual([]);
    const err = mockClient([{ data: null, error: { message: "read failed" } }]);
    await expect(listTelnyxCostDaily("2026-07-01", err.client)).rejects.toThrow(/read failed/);
  });

  it("falls back to the service client when none is provided", async () => {
    const { client } = mockClient([{ data: [], error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    expect(await listTelnyxCostDaily("2026-07-01")).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("replaceHostingerVpsCosts", () => {
  it("deletes everything then inserts the snapshot", async () => {
    const { client, calls } = mockClient([{ data: null, error: null }]);
    await replaceHostingerVpsCosts([HOSTINGER_ROW], client);
    expect(calls[0].ops).toEqual([
      { method: "delete", args: [] },
      { method: "neq", args: ["subscription_id", ""] }
    ]);
    expect(calls[1].ops[0]).toEqual({ method: "insert", args: [[HOSTINGER_ROW]] });
  });

  it("skips the insert on an empty snapshot", async () => {
    const { client, calls } = mockClient([{ data: null, error: null }]);
    await replaceHostingerVpsCosts([], client);
    expect(calls).toHaveLength(1);
  });

  it("throws on delete and insert errors", async () => {
    const del = mockClient([{ data: null, error: { message: "boom" } }]);
    await expect(replaceHostingerVpsCosts([HOSTINGER_ROW], del.client)).rejects.toThrow(
      /delete: boom/
    );
    const ins = mockClient([
      { data: null, error: null },
      { data: null, error: { message: "bang" } }
    ]);
    await expect(replaceHostingerVpsCosts([HOSTINGER_ROW], ins.client)).rejects.toThrow(
      /insert: bang/
    );
  });

  it("falls back to the service client when none is provided", async () => {
    const { client } = mockClient([{ data: null, error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    await replaceHostingerVpsCosts([]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("listHostingerVpsCosts", () => {
  it("returns the snapshot rows", async () => {
    const { client, calls } = mockClient([{ data: [HOSTINGER_ROW], error: null }]);
    const rows = await listHostingerVpsCosts(client);
    expect(rows).toEqual([HOSTINGER_ROW]);
    expect(calls[0].ops).toContainEqual({
      method: "order",
      args: ["next_billing_at", { ascending: true, nullsFirst: false }]
    });
  });

  it("handles null data and throws on error", async () => {
    const empty = mockClient([{ data: null, error: null }]);
    expect(await listHostingerVpsCosts(empty.client)).toEqual([]);
    const err = mockClient([{ data: null, error: { message: "read failed" } }]);
    await expect(listHostingerVpsCosts(err.client)).rejects.toThrow(/read failed/);
  });

  it("falls back to the service client when none is provided", async () => {
    const { client } = mockClient([{ data: [], error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    expect(await listHostingerVpsCosts()).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("listTenantDids", () => {
  it("merges messaging from-numbers and voice route DIDs, skipping unusable rows", async () => {
    const { client } = mockClient([
      {
        data: [
          { business_id: "biz-1", telnyx_sms_from_e164: "+16025551234" },
          { business_id: "biz-2", telnyx_sms_from_e164: null },
          { telnyx_sms_from_e164: "+16025559999" }
        ],
        error: null
      },
      {
        data: [
          { business_id: "biz-1", to_e164: "+16025554321" },
          { business_id: "biz-3", to_e164: null },
          { to_e164: "+16025558888" }
        ],
        error: null
      }
    ]);
    const dids = await listTenantDids(client);
    expect(dids).toEqual([
      { businessId: "biz-1", e164: "+16025551234" },
      { businessId: "biz-1", e164: "+16025554321" }
    ]);
  });

  it("handles null data pages", async () => {
    const { client } = mockClient([
      { data: null, error: null },
      { data: null, error: null }
    ]);
    expect(await listTenantDids(client)).toEqual([]);
  });

  it("throws on either side failing", async () => {
    const settingsErr = mockClient([
      { data: null, error: { message: "settings down" } },
      { data: [], error: null }
    ]);
    await expect(listTenantDids(settingsErr.client)).rejects.toThrow(/settings down/);
    const routesErr = mockClient([
      { data: [], error: null },
      { data: null, error: { message: "routes down" } }
    ]);
    await expect(listTenantDids(routesErr.client)).rejects.toThrow(/routes down/);
  });

  it("falls back to the service client when none is provided", async () => {
    const { client } = mockClient([
      { data: [], error: null },
      { data: [], error: null }
    ]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    expect(await listTenantDids()).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("listBusinessVpsAssignments", () => {
  it("parses vm ids and skips unusable rows", async () => {
    const { client } = mockClient([
      {
        data: [
          { id: "biz-1", hostinger_vps_id: "1800980" },
          { id: "biz-2", hostinger_vps_id: "not-a-number" },
          { id: "biz-3", hostinger_vps_id: "-4" },
          { id: "biz-4", hostinger_vps_id: null },
          { hostinger_vps_id: "42" }
        ],
        error: null
      }
    ]);
    const assignments = await listBusinessVpsAssignments(client);
    expect(assignments).toEqual([{ businessId: "biz-1", vmId: 1800980 }]);
  });

  it("handles null data and throws on error", async () => {
    const empty = mockClient([{ data: null, error: null }]);
    expect(await listBusinessVpsAssignments(empty.client)).toEqual([]);
    const err = mockClient([{ data: null, error: { message: "read failed" } }]);
    await expect(listBusinessVpsAssignments(err.client)).rejects.toThrow(/read failed/);
  });

  it("falls back to the service client when none is provided", async () => {
    const { client } = mockClient([{ data: [], error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    expect(await listBusinessVpsAssignments()).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});
