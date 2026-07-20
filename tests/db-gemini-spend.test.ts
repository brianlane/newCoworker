import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listGeminiBilledDaily,
  listGeminiSpendDaily,
  pruneGeminiSpendEvents,
  replaceGeminiBilledWindow,
  type GeminiBilledDailyInsert,
  type GeminiSpendDailyRow
} from "@/lib/db/gemini-spend";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type MockResponse = { data: unknown; error: { message: string } | null };

/** Same thenable query-builder mock as tests/db-platform-costs.test.ts. */
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
      for (const method of ["select", "gte", "order", "range"]) {
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

const SPEND_ROW: GeminiSpendDailyRow = {
  day: "2026-07-19",
  business_id: "biz-1",
  surface: "vps_rowboat",
  model: "gemini-2.5-flash-lite",
  pricing_source: "exact",
  call_count: 12,
  prompt_tokens: 24_000,
  output_tokens: 3_000,
  cost_micros: 3_600
};

const BILLED_ROW: GeminiBilledDailyInsert = {
  day: "2026-07-18",
  gcp_project_id: "gen-lang-client-1",
  cost_micros: 1_230_000
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listGeminiSpendDaily", () => {
  it("pages through full pages and concatenates", async () => {
    const fullPage = Array.from({ length: 1000 }, () => ({ ...SPEND_ROW }));
    const { client } = mockClient([
      { data: fullPage, error: null },
      { data: [{ ...SPEND_ROW, day: "2026-07-20" }], error: null }
    ]);
    const rows = await listGeminiSpendDaily("2026-07-01", client);
    expect(rows).toHaveLength(1001);
  });

  it("handles a null data page and throws on error", async () => {
    const empty = mockClient([{ data: null, error: null }]);
    expect(await listGeminiSpendDaily("2026-07-01", empty.client)).toEqual([]);
    const err = mockClient([{ data: null, error: { message: "read failed" } }]);
    await expect(listGeminiSpendDaily("2026-07-01", err.client)).rejects.toThrow(
      /listGeminiSpendDaily: read failed/
    );
  });

  it("falls back to the service client when none is provided", async () => {
    const { client } = mockClient([{ data: [], error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    expect(await listGeminiSpendDaily("2026-07-01")).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("replaceGeminiBilledWindow", () => {
  it("replaces the window atomically through the SQL function", async () => {
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    await replaceGeminiBilledWindow("2026-06-14", [BILLED_ROW], { rpc } as never);
    expect(rpc).toHaveBeenCalledWith("replace_gemini_billed_window", {
      p_window_start: "2026-06-14",
      p_rows: [BILLED_ROW]
    });
  });

  it("throws on an rpc error", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    await expect(
      replaceGeminiBilledWindow("2026-06-14", [BILLED_ROW], { rpc } as never)
    ).rejects.toThrow(/replaceGeminiBilledWindow: boom/);
  });

  it("falls back to the service client when none is provided", async () => {
    const rpc = vi.fn(async () => ({ data: 0, error: null }));
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({ rpc } as never);
    await replaceGeminiBilledWindow("2026-06-14", []);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("replace_gemini_billed_window", {
      p_window_start: "2026-06-14",
      p_rows: []
    });
  });
});

describe("listGeminiBilledDaily", () => {
  it("returns rows ordered day then project", async () => {
    const { client, calls } = mockClient([
      { data: [{ ...BILLED_ROW, id: 1, synced_at: "2026-07-19T11:10:00Z" }], error: null }
    ]);
    const rows = await listGeminiBilledDaily("2026-06-14", client);
    expect(rows).toHaveLength(1);
    expect(rows[0].gcp_project_id).toBe("gen-lang-client-1");
    expect(calls[0].ops).toContainEqual({ method: "gte", args: ["day", "2026-06-14"] });
  });

  it("pages through full pages and concatenates", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ ...BILLED_ROW, id: i + 1 }));
    const { client } = mockClient([
      { data: fullPage, error: null },
      { data: [{ ...BILLED_ROW, id: 1001 }], error: null }
    ]);
    const rows = await listGeminiBilledDaily("2026-06-14", client);
    expect(rows).toHaveLength(1001);
  });

  it("handles null data and throws on error", async () => {
    const empty = mockClient([{ data: null, error: null }]);
    expect(await listGeminiBilledDaily("2026-06-14", empty.client)).toEqual([]);
    const err = mockClient([{ data: null, error: { message: "read failed" } }]);
    await expect(listGeminiBilledDaily("2026-06-14", err.client)).rejects.toThrow(
      /listGeminiBilledDaily: read failed/
    );
  });

  it("falls back to the service client when none is provided", async () => {
    const { client } = mockClient([{ data: [], error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    expect(await listGeminiBilledDaily("2026-06-14")).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("pruneGeminiSpendEvents", () => {
  it("calls the prune RPC and returns the removed count", async () => {
    const rpc = vi.fn(async () => ({ data: 42, error: null }));
    expect(await pruneGeminiSpendEvents({ rpc } as never)).toBe(42);
    expect(rpc).toHaveBeenCalledWith("gemini_spend_events_prune", { p_keep_days: 200 });
  });

  it("normalizes non-positive/unusable counts to 0 and throws on error", async () => {
    const rpcNull = vi.fn(async () => ({ data: null, error: null }));
    expect(await pruneGeminiSpendEvents({ rpc: rpcNull } as never)).toBe(0);
    const rpcNegative = vi.fn(async () => ({ data: -3, error: null }));
    expect(await pruneGeminiSpendEvents({ rpc: rpcNegative } as never)).toBe(0);
    const rpcErr = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    await expect(pruneGeminiSpendEvents({ rpc: rpcErr } as never)).rejects.toThrow(
      /pruneGeminiSpendEvents: boom/
    );
  });

  it("falls back to the service client when none is provided", async () => {
    const rpc = vi.fn(async () => ({ data: 0, error: null }));
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({ rpc } as never);
    expect(await pruneGeminiSpendEvents()).toBe(0);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});
