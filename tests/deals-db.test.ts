import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DealError,
  createDeal,
  deleteDeal,
  listDeals,
  listDealsWithContacts,
  updateDeal
} from "@/lib/deals/db";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/db/contact-names", () => ({
  resolveContactNames: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveContactNames } from "@/lib/db/contact-names";

type Result = { data: unknown; error: unknown; count?: number | null };

/** Thenable PostgREST-chain stub (mirrors segments-db.test.ts). */
function chain(result: Result) {
  const c: Record<string, unknown> = {};
  for (const m of [
    "select",
    "insert",
    "update",
    "delete",
    "eq",
    "in",
    "gte",
    "order",
    "limit",
    "single",
    "maybeSingle"
  ]) {
    c[m] = vi.fn(() => c);
  }
  (c as { then: unknown }).then = (
    resolve: (v: Result) => unknown,
    reject: (e: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject);
  return c as Record<string, ReturnType<typeof vi.fn>> & PromiseLike<Result>;
}

function mockDb(queue: Result[]) {
  const remaining = [...queue];
  const chains: ReturnType<typeof chain>[] = [];
  const from = vi.fn(() => {
    const result =
      remaining.length > 1
        ? remaining.shift()!
        : remaining[0] ?? { data: null, error: { message: "no mock" } };
    const c = chain(result);
    chains.push(c);
    return c;
  });
  return { from, chains };
}

const ROW = {
  id: "deal-1",
  business_id: "biz-1",
  contact_id: null as string | null,
  title: "Roof job",
  value_cents: 4500000,
  currency: "USD",
  commission_bps: 250,
  expected_close_date: "2026-09-15",
  status: "open",
  won_at: null as string | null,
  lost_at: null as string | null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z"
};

const DEAL = {
  id: "deal-1",
  businessId: "biz-1",
  contactId: null,
  title: "Roof job",
  valueCents: 4500000,
  currency: "USD",
  commissionBps: 250,
  expectedCloseDate: "2026-09-15",
  status: "open",
  wonAt: null,
  lostAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveContactNames).mockResolvedValue(new Map());
});

describe("listDeals", () => {
  it("maps rows onto the camelCase Deal shape", async () => {
    const db = mockDb([{ data: [ROW], error: null }]);
    expect(await listDeals("biz-1", db as never)).toEqual([DEAL]);
    expect(db.chains[0].eq).toHaveBeenCalledWith("business_id", "biz-1");
  });

  it("handles null rows and creates a service client when none is passed", async () => {
    const db = mockDb([{ data: null, error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listDeals("biz-1")).toEqual([]);
  });

  it("throws on a read error", async () => {
    const db = mockDb([{ data: null, error: { message: "down" } }]);
    await expect(listDeals("biz-1", db as never)).rejects.toThrow("listDeals: down");
  });
});

describe("listDealsWithContacts", () => {
  it("resolves contact names with resolver > stored label > raw key precedence", async () => {
    const db = mockDb([
      {
        data: [
          { ...ROW, id: "d1", contact_id: "c1" },
          { ...ROW, id: "d2", contact_id: "c2" },
          { ...ROW, id: "d3", contact_id: "c3" },
          { ...ROW, id: "d4", contact_id: null },
          { ...ROW, id: "d5", contact_id: "c-gone" }
        ],
        error: null
      },
      {
        data: [
          { id: "c1", customer_e164: "+15550001111", display_name: "Stored One" },
          { id: "c2", customer_e164: "+15550002222", display_name: "Stored Two" },
          { id: "c3", customer_e164: "+15550003333", display_name: null }
        ],
        error: null
      }
    ]);
    vi.mocked(resolveContactNames).mockResolvedValue(
      new Map([["+15550001111", { name: "Resolved One", kind: "customer" as const }]])
    );

    const deals = await listDealsWithContacts("biz-1", db as never);
    expect(deals.map((d) => [d.id, d.contactE164, d.contactName])).toEqual([
      ["d1", "+15550001111", "Resolved One"],
      ["d2", "+15550002222", "Stored Two"],
      ["d3", "+15550003333", "+15550003333"],
      ["d4", null, null],
      ["d5", null, null]
    ]);
    expect(resolveContactNames).toHaveBeenCalledWith(
      "biz-1",
      ["+15550001111", "+15550002222", "+15550003333"],
      db
    );
  });

  it("skips the contacts query when no deal is linked", async () => {
    const db = mockDb([{ data: [{ ...ROW, contact_id: null }], error: null }]);
    const deals = await listDealsWithContacts("biz-1", db as never);
    expect(deals[0]).toMatchObject({ contactE164: null, contactName: null });
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it("throws when the contacts read fails, and tolerates a null contacts page", async () => {
    const down = mockDb([
      { data: [{ ...ROW, contact_id: "c1" }], error: null },
      { data: null, error: { message: "down" } }
    ]);
    await expect(listDealsWithContacts("biz-1", down as never)).rejects.toThrow(
      "listDealsWithContacts: contacts: down"
    );

    const empty = mockDb([
      { data: [{ ...ROW, contact_id: "c1" }], error: null },
      { data: null, error: null }
    ]);
    const deals = await listDealsWithContacts("biz-1", empty as never);
    expect(deals[0]).toMatchObject({ contactE164: null, contactName: null });
  });

  it("a name-resolution blip degrades to the stored label instead of failing", async () => {
    const db = mockDb([
      { data: [{ ...ROW, contact_id: "c1" }], error: null },
      {
        data: [{ id: "c1", customer_e164: "+15550001111", display_name: "Stored One" }],
        error: null
      }
    ]);
    vi.mocked(resolveContactNames).mockRejectedValue(new Error("resolver down"));
    const deals = await listDealsWithContacts("biz-1", db as never);
    expect(deals[0]).toMatchObject({
      contactE164: "+15550001111",
      contactName: "Stored One"
    });
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb([{ data: [], error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listDealsWithContacts("biz-1")).toEqual([]);
  });
});

describe("createDeal", () => {
  it("inserts defaults for a minimal deal", async () => {
    const db = mockDb([{ data: ROW, error: null }]);
    const deal = await createDeal("biz-1", { title: "Roof job" }, "user-1", db as never);
    expect(deal.id).toBe("deal-1");
    const insert = db.chains[0].insert.mock.calls[0][0];
    expect(insert).toMatchObject({
      business_id: "biz-1",
      contact_id: null,
      title: "Roof job",
      value_cents: null,
      currency: "USD",
      commission_bps: null,
      expected_close_date: null,
      status: "open",
      won_at: null,
      lost_at: null,
      created_by: "user-1"
    });
  });

  it("a deal created straight into won carries its stamp", async () => {
    const db = mockDb([{ data: { ...ROW, status: "won" }, error: null }]);
    await createDeal(
      "biz-1",
      {
        title: "Backfilled sale",
        contactId: "c1",
        valueCents: 100,
        currency: "USD",
        commissionBps: 100,
        expectedCloseDate: "2026-08-01",
        status: "won"
      },
      null,
      db as never
    );
    const insert = db.chains[0].insert.mock.calls[0][0];
    expect(insert.status).toBe("won");
    expect(typeof insert.won_at).toBe("string");
    expect(insert.lost_at).toBeNull();
    expect(insert.contact_id).toBe("c1");
  });

  it("maps a broken contact FK onto the invalid error; other failures throw plainly", async () => {
    const fk = mockDb([{ data: null, error: { code: "23503", message: "fk" } }]);
    await expect(
      createDeal("biz-1", { title: "x", contactId: "c-gone" }, null, fk as never)
    ).rejects.toMatchObject({ code: "invalid" });

    const down = mockDb([{ data: null, error: { message: "down" } }]);
    await expect(createDeal("biz-1", { title: "x" }, null, down as never)).rejects.toThrow(
      "createDeal: down"
    );

    const empty = mockDb([{ data: null, error: null }]);
    await expect(createDeal("biz-1", { title: "x" }, null, empty as never)).rejects.toThrow(
      "insert returned no row"
    );
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb([{ data: ROW, error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const deal = await createDeal("biz-1", { title: "Roof job" }, null);
    expect(deal.id).toBe("deal-1");
  });
});

describe("updateDeal", () => {
  it("patches fields without touching the status stamps", async () => {
    const db = mockDb([
      { data: ROW, error: null },
      { data: { ...ROW, title: "Bigger roof job" }, error: null }
    ]);
    const deal = await updateDeal(
      "biz-1",
      "deal-1",
      {
        title: "Bigger roof job",
        contactId: "c1",
        valueCents: 5000000,
        currency: "USD",
        commissionBps: 300,
        expectedCloseDate: "2026-10-01",
        status: "open"
      },
      db as never
    );
    expect(deal.title).toBe("Bigger roof job");
    const update = db.chains[1].update.mock.calls[0][0];
    expect(update).toMatchObject({
      title: "Bigger roof job",
      contact_id: "c1",
      value_cents: 5000000,
      commission_bps: 300,
      expected_close_date: "2026-10-01"
    });
    // Status equals the current one: no transition, no stamp rewrite.
    expect(update).not.toHaveProperty("status");
    expect(update).not.toHaveProperty("won_at");
  });

  it("a legal close stamps won_at and clears lost_at", async () => {
    const db = mockDb([
      { data: ROW, error: null },
      { data: { ...ROW, status: "won", won_at: "2026-08-20T00:00:00.000Z" }, error: null }
    ]);
    const deal = await updateDeal("biz-1", "deal-1", { status: "won" }, db as never);
    expect(deal.status).toBe("won");
    const update = db.chains[1].update.mock.calls[0][0];
    expect(update.status).toBe("won");
    expect(typeof update.won_at).toBe("string");
    expect(update.lost_at).toBeNull();
  });

  it("refuses an illegal won -> lost flip with a transition error", async () => {
    const db = mockDb([
      { data: { ...ROW, status: "won", won_at: "2026-08-10T00:00:00.000Z" }, error: null }
    ]);
    await expect(
      updateDeal("biz-1", "deal-1", { status: "lost" }, db as never)
    ).rejects.toMatchObject({
      code: "transition",
      message: expect.stringContaining("reopen")
    });
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it("read failures, missing rows, and write failures map distinctly", async () => {
    const readDown = mockDb([{ data: null, error: { message: "down" } }]);
    await expect(
      updateDeal("biz-1", "deal-1", { title: "x" }, readDown as never)
    ).rejects.toThrow("updateDeal: read: down");

    const missing = mockDb([{ data: null, error: null }]);
    await expect(
      updateDeal("biz-1", "deal-x", { title: "x" }, missing as never)
    ).rejects.toMatchObject({ code: "not_found" });

    const fk = mockDb([
      { data: ROW, error: null },
      { data: null, error: { code: "23503", message: "fk" } }
    ]);
    await expect(
      updateDeal("biz-1", "deal-1", { contactId: "c-gone" }, fk as never)
    ).rejects.toMatchObject({ code: "invalid" });

    const writeDown = mockDb([
      { data: ROW, error: null },
      { data: null, error: { message: "down" } }
    ]);
    await expect(
      updateDeal("biz-1", "deal-1", { title: "x" }, writeDown as never)
    ).rejects.toThrow("updateDeal: down");

    // A no-match write returns no error and no row: still not found.
    const vanished = mockDb([
      { data: ROW, error: null },
      { data: null, error: null }
    ]);
    await expect(
      updateDeal("biz-1", "deal-1", { title: "x" }, vanished as never)
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb([
      { data: ROW, error: null },
      { data: ROW, error: null }
    ]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const deal = await updateDeal("biz-1", "deal-1", { title: "Roof job" });
    expect(deal.id).toBe("deal-1");
  });
});

describe("deleteDeal", () => {
  it("deletes by business + id", async () => {
    const db = mockDb([{ data: [{ id: "deal-1" }], error: null }]);
    await deleteDeal("biz-1", "deal-1", db as never);
    expect(db.chains[0].eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(db.chains[0].eq).toHaveBeenCalledWith("id", "deal-1");
  });

  it("zero deleted rows is not_found; a db error throws plainly", async () => {
    const missing = mockDb([{ data: [], error: null }]);
    await expect(deleteDeal("biz-1", "deal-x", missing as never)).rejects.toMatchObject({
      code: "not_found"
    });
    await expect(
      deleteDeal("biz-1", "deal-x", mockDb([{ data: null, error: null }]) as never)
    ).rejects.toBeInstanceOf(DealError);

    const down = mockDb([{ data: null, error: { message: "down" } }]);
    await expect(deleteDeal("biz-1", "deal-1", down as never)).rejects.toThrow(
      "deleteDeal: down"
    );
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb([{ data: [{ id: "deal-1" }], error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await deleteDeal("biz-1", "deal-1");
    expect(db.from).toHaveBeenCalled();
  });
});
