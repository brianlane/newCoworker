import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  countByBusiness,
  listInboundDeadLetters,
  type InboundDeadLetterRow
} from "@/lib/db/sms-dead-letters";

type Row = Record<string, unknown>;

/** Records the filters applied so the query contract can be asserted. */
function fakeClient(result: { data?: Row[]; error?: { message: string } }) {
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
    return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
  };
  const client = {
    from: (table: string) => {
      record("from", table);
      return builder;
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

describe("countByBusiness", () => {
  const row = (businessId: string): InboundDeadLetterRow => ({
    id: `${businessId}-${Math.random()}`,
    businessId,
    createdAt: "2026-07-28T00:00:00.000Z",
    attemptCount: 1,
    error: "missing_from_or_text",
    from: "73339",
    preview: ""
  });

  it("puts the most affected tenant first", () => {
    expect(countByBusiness([row("a"), row("b"), row("b"), row("c"), row("b")])).toEqual([
      { businessId: "b", count: 3 },
      { businessId: "a", count: 1 },
      { businessId: "c", count: 1 }
    ]);
  });

  it("breaks ties predictably, so the card does not reshuffle between loads", () => {
    expect(countByBusiness([row("z"), row("a")])).toEqual([
      { businessId: "a", count: 1 },
      { businessId: "z", count: 1 }
    ]);
  });

  it("handles nothing", () => {
    expect(countByBusiness([])).toEqual([]);
  });
});
