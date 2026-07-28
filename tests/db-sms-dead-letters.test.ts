import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  listInboundDeadLetters,
  summarizeInboundDeadLetters
} from "@/lib/db/sms-dead-letters";

type Row = Record<string, unknown>;

/** Records the filters applied so the query contract can be asserted. */
function fakeClient(result: {
  data?: Row[];
  error?: { message: string };
  count?: number;
  rpcData?: Row[];
}) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, ...args: unknown[]) => {
    calls[name] = [...(calls[name] ?? []), args];
  };
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "gte", "order"]) {
    builder[m] = (...args: unknown[]) => {
      record(m, ...args);
      return builder;
    };
  }
  builder.limit = (...args: unknown[]) => {
    record("limit", ...args);
    return Promise.resolve({
      data: result.data ?? null,
      error: result.error ?? null,
      count: result.count
    });
  };
  const client = {
    from: (table: string) => {
      record("from", table);
      return builder;
    },
    rpc: (fn: string, args: unknown) => {
      record("rpc", fn, args);
      return Promise.resolve({ data: result.rpcData ?? null, error: result.error ?? null });
    }
  } as unknown as SupabaseClient;
  return { client, calls };
}

const jobRow = (over: Row = {}): Row => ({
  id: "job-1",
  business_id: "biz-1",
  created_at: "2026-07-28T16:15:12.000Z",
  attempt_count: 1,
  last_error: "missing_from_or_text",
  payload: {
    data: {
      payload: { from: { phone_number: "73339" }, text: "ReferralExchange   PRIME\nmatched you" }
    }
  },
  ...over
});

describe("listInboundDeadLetters", () => {
  it("returns only dead-lettered, undeleted jobs, newest first", async () => {
    const { client, calls } = fakeClient({ data: [jobRow()] });
    const rows = await listInboundDeadLetters({ sinceDays: 14, limit: 20 }, client);
    expect(calls.from[0]).toEqual(["sms_inbound_jobs"]);
    expect(calls.eq).toContainEqual(["status", "dead_letter"]);
    expect(calls.is).toContainEqual(["deleted_at", null]);
    expect(calls.order[0]).toEqual(["created_at", { ascending: false }]);
    expect(calls.limit[0]).toEqual([20]);
    expect(rows).toHaveLength(1);
  });

  it("flattens the Telnyx envelope into a sender and a one-line preview", async () => {
    const { client } = fakeClient({ data: [jobRow()] });
    const [row] = await listInboundDeadLetters(undefined, client);
    expect(row).toMatchObject({
      id: "job-1",
      businessId: "biz-1",
      error: "missing_from_or_text",
      from: "73339",
      attemptCount: 1
    });
    // Whitespace collapsed so a multi-line alert stays readable in one row.
    expect(row!.preview).toBe("ReferralExchange PRIME matched you");
  });

  it("scopes to one tenant when asked, and stays fleet-wide otherwise", async () => {
    const scoped = fakeClient({ data: [] });
    await listInboundDeadLetters({ businessId: "biz-9" }, scoped.client);
    expect(scoped.calls.eq).toContainEqual(["business_id", "biz-9"]);

    const fleet = fakeClient({ data: [] });
    await listInboundDeadLetters({}, fleet.client);
    expect(fleet.calls.eq ?? []).not.toContainEqual(["business_id", "biz-9"]);
    // No window means no created_at filter at all.
    expect(fleet.calls.gte).toBeUndefined();
  });

  it("ignores a zero or negative window rather than querying the future", async () => {
    const { calls } = fakeClient({ data: [] });
    const c = fakeClient({ data: [] });
    await listInboundDeadLetters({ sinceDays: 0 }, c.client);
    expect(c.calls.gte).toBeUndefined();
    expect(calls.gte).toBeUndefined();
  });

  it("defaults the row limit", async () => {
    const { client, calls } = fakeClient({ data: [] });
    await listInboundDeadLetters(undefined, client);
    expect(calls.limit[0]).toEqual([25]);
  });

  it("survives missing fields and a query error without breaking the page", async () => {
    const sparse = fakeClient({ data: [{ id: "j", business_id: "b", created_at: "t" }] });
    const [row] = await listInboundDeadLetters(undefined, sparse.client);
    expect(row).toMatchObject({ error: "unknown", from: "", preview: "", attemptCount: 0 });

    const broken = fakeClient({ error: { message: "boom" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await listInboundDeadLetters(undefined, broken.client)).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    const empty = fakeClient({});
    expect(await listInboundDeadLetters(undefined, empty.client)).toEqual([]);
  });

  it("falls back to the service client when none is injected", async () => {
    // The admin card calls it with no client, so that default has to work.
    const { client } = fakeClient({ data: [jobRow()] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    const rows = await listInboundDeadLetters({ sinceDays: 14 });
    expect(rows).toHaveLength(1);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });

  it("truncates a long message", async () => {
    const { client } = fakeClient({
      data: [
        jobRow({
          payload: { data: { payload: { from: { phone_number: "1" }, text: "x".repeat(400) } } }
        })
      ]
    });
    const [row] = await listInboundDeadLetters(undefined, client);
    expect(row!.preview.length).toBe(160);
  });

  it("tolerates a payload that is not the expected shape", async () => {
    const { client } = fakeClient({
      data: [
        jobRow({ payload: null }),
        jobRow({ id: "job-2", payload: { data: { payload: { from: 7, text: 9 } } } })
      ]
    });
    const rows = await listInboundDeadLetters(undefined, client);
    expect(rows.map((r) => r.from)).toEqual(["", ""]);
    expect(rows.map((r) => r.preview)).toEqual(["", ""]);
  });

  it("shows an unusable origin verbatim instead of hiding it", async () => {
    // These rows exist BECAUSE the sender was unusable, so blanking it would
    // remove the only evidence. customerE164FromPayload correctly refuses these.
    const { client } = fakeClient({
      data: [
        jobRow({ id: "a", payload: { data: { payload: { from: "SHORTNAME", text: "hi" } } } }),
        jobRow({
          id: "b",
          payload: { data: { payload: { from: { phone_number: "not-a-number" }, text: "hi" } } }
        }),
        jobRow({ id: "c", payload: { data: { payload: { from: {}, text: "hi" } } } })
      ]
    });
    const rows = await listInboundDeadLetters(undefined, client);
    expect(rows.map((r) => r.from)).toEqual(["SHORTNAME", "not-a-number", ""]);
  });

  it("reads every envelope shape Telnyx actually sends", async () => {
    // Telnyx is inconsistent: `from` is sometimes a bare string, the body is
    // `text` or `body`, and RCS nests it under a body object. Parsing only one
    // shape would show "(no sender)" and a blank preview for a real failure.
    const { client } = fakeClient({
      data: [
        jobRow({ id: "a", payload: { data: { payload: { from: "+16025550100", body: "in body" } } } }),
        jobRow({ id: "b", payload: { data: { payload: { from: "73339", text: "short code" } } } }),
        jobRow({
          id: "c",
          payload: { data: { payload: { from: { phone_number: "+16025550101" }, body: { text: "rcs" } } } }
        })
      ]
    });
    const rows = await listInboundDeadLetters(undefined, client);
    expect(rows.map((r) => r.from)).toEqual(["+16025550100", "73339", "+16025550101"]);
    expect(rows.map((r) => r.preview)).toEqual(["in body", "short code", "rcs"]);
  });
});

describe("summarizeInboundDeadLetters", () => {
  it("takes exact per-tenant counts from the grouped SQL count", async () => {
    // Never from the displayed sample: a noisy tenant would crowd others out and
    // every number would understate the truth without saying so.
    const { client, calls } = fakeClient({
      rpcData: [
        { business_id: "biz-a", failure_count: 300 },
        { business_id: "biz-b", failure_count: 4 }
      ]
    });
    const s = await summarizeInboundDeadLetters({ sinceDays: 14 }, client);
    expect((calls.rpc[0] as unknown[])[0]).toBe("inbound_dead_letter_counts");
    expect(s.total).toBe(304);
    expect(s.byBusiness).toEqual([
      { businessId: "biz-a", count: 300 },
      { businessId: "biz-b", count: 4 }
    ]);
  });

  it("passes the window, and null for all time", async () => {
    const windowed = fakeClient({ rpcData: [] });
    await summarizeInboundDeadLetters({ sinceDays: 14 }, windowed.client);
    const wArgs = windowed.calls.rpc[0] as unknown[];
    expect(typeof (wArgs[1] as { p_since: string }).p_since).toBe("string");

    for (const options of [undefined, {}, { sinceDays: 0 }]) {
      const all = fakeClient({ rpcData: [] });
      await summarizeInboundDeadLetters(options, all.client);
      const aArgs = all.calls.rpc[0] as unknown[];
      expect((aArgs[1] as { p_since: string | null }).p_since).toBeNull();
    }
  });

  it("reports zero rather than throwing when the count fails", async () => {
    const { client } = fakeClient({ error: { message: "boom" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await summarizeInboundDeadLetters(undefined, client)).toEqual({
      total: 0,
      byBusiness: []
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("handles an empty or malformed count row", async () => {
    const empty = fakeClient({});
    expect(await summarizeInboundDeadLetters(undefined, empty.client)).toEqual({
      total: 0,
      byBusiness: []
    });
    const sparse = fakeClient({ rpcData: [{ business_id: "b" }] });
    expect(await summarizeInboundDeadLetters(undefined, sparse.client)).toEqual({
      total: 0,
      byBusiness: [{ businessId: "b", count: 0 }]
    });
  });

  it("uses the service client when none is injected", async () => {
    const { client } = fakeClient({ rpcData: [] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    await summarizeInboundDeadLetters();
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});
