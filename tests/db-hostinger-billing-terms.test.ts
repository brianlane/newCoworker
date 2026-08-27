import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listHostingerBillingTerms,
  upsertHostingerBillingTerms
} from "@/lib/db/hostinger-billing-terms";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type MockResponse = { data: unknown; error: { message: string } | null };

function mockClient(response: MockResponse) {
  const calls: Array<{ table: string; ops: Array<{ method: string; args: unknown[] }> }> = [];
  const client = {
    from(table: string) {
      const record = { table, ops: [] as Array<{ method: string; args: unknown[] }> };
      calls.push(record);
      const builder: Record<string, unknown> = {
        then(onFulfilled?: (v: MockResponse) => unknown, onRejected?: (r: unknown) => unknown) {
          return Promise.resolve(response).then(onFulfilled, onRejected);
        }
      };
      for (const method of ["select", "upsert", "eq"]) {
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

const ROW = {
  subscription_id: "16BcBrVOTACBI8WdU",
  observed_next_billing_at: "2027-09-05T04:23:54Z",
  term_months: 12,
  monthly_cents: 1299,
  source: "runway_match" as const,
  inferred_at: "2026-08-27T12:00:00.000Z",
  updated_at: "2026-08-27T12:00:00.000Z"
};

beforeEach(() => vi.clearAllMocks());

describe("listHostingerBillingTerms", () => {
  it("returns the stored rows", async () => {
    const { client, calls } = mockClient({ data: [ROW], error: null });
    expect(await listHostingerBillingTerms(client)).toEqual([ROW]);
    expect(calls[0].table).toBe("hostinger_billing_terms");
  });

  it("handles null data and throws on error", async () => {
    expect(await listHostingerBillingTerms(mockClient({ data: null, error: null }).client)).toEqual([]);
    await expect(
      listHostingerBillingTerms(mockClient({ data: null, error: { message: "denied" } }).client)
    ).rejects.toThrow(/denied/);
  });

  it("falls back to the service client when none is provided", async () => {
    const { client } = mockClient({ data: [], error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    expect(await listHostingerBillingTerms()).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("upsertHostingerBillingTerms", () => {
  it("upserts on the subscription key and stamps updated_at", async () => {
    const { client, calls } = mockClient({ data: null, error: null });
    await upsertHostingerBillingTerms(
      [
        {
          subscription_id: "sub-1",
          observed_next_billing_at: "2027-09-05T04:23:54Z",
          term_months: 12,
          monthly_cents: 1299,
          source: "jump",
          inferred_at: "2026-08-27T12:00:00.000Z"
        }
      ],
      client
    );
    const upsert = calls[0].ops.find((o) => o.method === "upsert");
    expect(upsert?.args[1]).toEqual({ onConflict: "subscription_id" });
    const rows = upsert?.args[0] as Array<Record<string, unknown>>;
    expect(rows[0].subscription_id).toBe("sub-1");
    expect(typeof rows[0].updated_at).toBe("string");
  });

  it("does nothing at all for an empty list, never touching the client", async () => {
    // A sync that saw no VPS subscriptions must not issue a write, and must
    // certainly not resolve a service client to do nothing with.
    const { calls } = mockClient({ data: null, error: null });
    await upsertHostingerBillingTerms([]);
    expect(calls).toHaveLength(0);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("throws on error", async () => {
    await expect(
      upsertHostingerBillingTerms(
        [
          {
            subscription_id: "sub-1",
            observed_next_billing_at: null,
            term_months: null,
            monthly_cents: null,
            source: null,
            inferred_at: null
          }
        ],
        mockClient({ data: null, error: { message: "write failed" } }).client
      )
    ).rejects.toThrow(/write failed/);
  });

  it("falls back to the service client when none is provided", async () => {
    const { client } = mockClient({ data: null, error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    await upsertHostingerBillingTerms([
      {
        subscription_id: "sub-1",
        observed_next_billing_at: null,
        term_months: null,
        monthly_cents: null,
        source: null,
        inferred_at: null
      }
    ]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});
