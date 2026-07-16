import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SegmentError,
  createContactSegment,
  deleteContactSegment,
  listContactSegments,
  updateContactSegment
} from "@/lib/segments/db";
import { MAX_SEGMENTS_PER_BUSINESS } from "@/lib/segments/core";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type Result = { data: unknown; error: unknown };

/** Thenable PostgREST-chain stub (mirrors pipelines-db.test.ts). */
function chain(result: Result) {
  const c: Record<string, unknown> = {};
  for (const m of [
    "select",
    "insert",
    "update",
    "delete",
    "eq",
    "order",
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
  id: "seg-1",
  business_id: "biz-1",
  name: "Hot leads",
  filters: { tagsAny: ["VIP"] },
  position: 0
};

beforeEach(() => vi.clearAllMocks());

describe("listContactSegments", () => {
  it("maps rows and validates stored filters", async () => {
    const db = mockDb([{ data: [ROW], error: null }]);
    const segments = await listContactSegments("biz-1", db as never);
    expect(segments).toEqual([
      {
        id: "seg-1",
        businessId: "biz-1",
        name: "Hot leads",
        filters: { tagsAny: ["VIP"] },
        position: 0
      }
    ]);
  });

  it("degrades malformed stored filters to 'all contacts' instead of throwing", async () => {
    const db = mockDb([
      { data: [{ ...ROW, filters: { bogus: 1 } }, { ...ROW, id: "seg-2", filters: "junk" }], error: null }
    ]);
    const segments = await listContactSegments("biz-1", db as never);
    expect(segments.map((s) => s.filters)).toEqual([{}, {}]);
  });

  it("handles null rows and creates a service client when none is passed", async () => {
    const db = mockDb([{ data: null, error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listContactSegments("biz-1")).toEqual([]);
  });

  it("throws on a read error", async () => {
    const db = mockDb([{ data: null, error: { message: "down" } }]);
    await expect(listContactSegments("biz-1", db as never)).rejects.toThrow(
      "listContactSegments: down"
    );
  });
});

describe("createContactSegment", () => {
  it("inserts at the end of the chip row", async () => {
    const db = mockDb([
      { data: [{ id: "a" }, { id: "b" }], error: null }, // count
      { data: { ...ROW, position: 2 }, error: null } // insert
    ]);
    const segment = await createContactSegment(
      "biz-1",
      " Hot leads ",
      { tagsAny: ["VIP"] },
      db as never
    );
    expect(segment.position).toBe(2);
    const insert = db.chains[1].insert.mock.calls[0][0];
    expect(insert).toMatchObject({ business_id: "biz-1", name: "Hot leads", position: 2 });
  });

  it("rejects blank / oversized names", async () => {
    const db = mockDb([]);
    await expect(
      createContactSegment("biz-1", "   ", {}, db as never)
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      createContactSegment("biz-1", "x".repeat(61), {}, db as never)
    ).rejects.toBeInstanceOf(SegmentError);
  });

  it("enforces the per-business cap", async () => {
    const db = mockDb([
      { data: Array.from({ length: MAX_SEGMENTS_PER_BUSINESS }, (_, i) => ({ id: `s${i}` })), error: null }
    ]);
    await expect(
      createContactSegment("biz-1", "One more", {}, db as never)
    ).rejects.toMatchObject({ code: "limit" });
  });

  it("maps a 23505 onto the duplicate error; other failures throw plainly", async () => {
    const dup = mockDb([
      { data: [], error: null },
      { data: null, error: { code: "23505", message: "dup" } }
    ]);
    await expect(
      createContactSegment("biz-1", "Hot leads", {}, dup as never)
    ).rejects.toMatchObject({ code: "duplicate" });

    const down = mockDb([
      { data: [], error: null },
      { data: null, error: { message: "insert down" } }
    ]);
    await expect(
      createContactSegment("biz-1", "Hot leads", {}, down as never)
    ).rejects.toThrow("createContactSegment: insert down");

    const empty = mockDb([
      { data: [], error: null },
      { data: null, error: null }
    ]);
    await expect(
      createContactSegment("biz-1", "Hot leads", {}, empty as never)
    ).rejects.toThrow("insert returned no row");

    const countDown = mockDb([{ data: null, error: { message: "count down" } }]);
    await expect(
      createContactSegment("biz-1", "Hot leads", {}, countDown as never)
    ).rejects.toThrow("createContactSegment: count: count down");
  });

  it("a null count page counts as zero", async () => {
    const db = mockDb([
      { data: null, error: null },
      { data: ROW, error: null }
    ]);
    const segment = await createContactSegment("biz-1", "Hot leads", {}, db as never);
    expect(segment.id).toBe("seg-1");
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb([
      { data: [], error: null },
      { data: ROW, error: null }
    ]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const segment = await createContactSegment("biz-1", "Hot leads", {});
    expect(segment.id).toBe("seg-1");
  });
});

describe("updateContactSegment", () => {
  it("renames and/or replaces filters", async () => {
    const db = mockDb([{ data: { ...ROW, name: "Warm leads" }, error: null }]);
    const segment = await updateContactSegment(
      "biz-1",
      "seg-1",
      { name: "Warm leads", filters: {} },
      db as never
    );
    expect(segment.name).toBe("Warm leads");
    const update = db.chains[0].update.mock.calls[0][0];
    expect(update).toMatchObject({ name: "Warm leads", filters: {} });
  });

  it("a filters-only patch leaves the name untouched", async () => {
    const db = mockDb([{ data: ROW, error: null }]);
    await updateContactSegment("biz-1", "seg-1", { filters: { neverContacted: true } }, db as never);
    const update = db.chains[0].update.mock.calls[0][0];
    expect(update).not.toHaveProperty("name");
    expect(update).toMatchObject({ filters: { neverContacted: true } });
  });

  it("not-found, duplicate, and plain errors map distinctly", async () => {
    const missing = mockDb([{ data: null, error: null }]);
    await expect(
      updateContactSegment("biz-1", "seg-x", { name: "x" }, missing as never)
    ).rejects.toMatchObject({ code: "not_found" });

    const dup = mockDb([{ data: null, error: { code: "23505", message: "dup" } }]);
    await expect(
      updateContactSegment("biz-1", "seg-1", { name: "Hot leads" }, dup as never)
    ).rejects.toMatchObject({ code: "duplicate" });

    const down = mockDb([{ data: null, error: { message: "down" } }]);
    await expect(
      updateContactSegment("biz-1", "seg-1", { name: "x" }, down as never)
    ).rejects.toThrow("updateContactSegment: down");

    const badName = mockDb([]);
    await expect(
      updateContactSegment("biz-1", "seg-1", { name: " " }, badName as never)
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb([{ data: ROW, error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const segment = await updateContactSegment("biz-1", "seg-1", { name: "Hot leads" });
    expect(segment.id).toBe("seg-1");
  });
});

describe("deleteContactSegment", () => {
  it("deletes by business + id", async () => {
    const db = mockDb([{ data: [{ id: "seg-1" }], error: null }]);
    await deleteContactSegment("biz-1", "seg-1", db as never);
    expect(db.chains[0].eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(db.chains[0].eq).toHaveBeenCalledWith("id", "seg-1");
  });

  it("zero deleted rows is not_found; a db error throws plainly", async () => {
    const missing = mockDb([{ data: [], error: null }]);
    await expect(
      deleteContactSegment("biz-1", "seg-x", missing as never)
    ).rejects.toMatchObject({ code: "not_found" });

    const nullRows = mockDb([{ data: null, error: null }]);
    await expect(
      deleteContactSegment("biz-1", "seg-x", nullRows as never)
    ).rejects.toMatchObject({ code: "not_found" });

    const down = mockDb([{ data: null, error: { message: "down" } }]);
    await expect(deleteContactSegment("biz-1", "seg-1", down as never)).rejects.toThrow(
      "deleteContactSegment: down"
    );
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb([{ data: [{ id: "seg-1" }], error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await deleteContactSegment("biz-1", "seg-1");
    expect(db.from).toHaveBeenCalled();
  });
});
