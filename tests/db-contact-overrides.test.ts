import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  CONTACT_NUMBER_RE,
  deleteContactOverride,
  listContactOverrides,
  setContactOverride
} from "@/lib/db/contact-overrides";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";

type OpResult = { data?: unknown; error: { message: string } | null };
type Results = {
  update?: OpResult;
  insert?: OpResult;
  select?: OpResult;
  delete?: OpResult;
};

// Manual contacts now live on the unified `contacts` table, so the lib uses
// update-then-insert (not a blind upsert) to avoid demoting an existing
// customer's type. The mock resolves the awaited chain by the write op invoked.
function makeDb(results: Results = {}) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const resolved: Required<Results> = {
    update: results.update ?? { data: [{ id: "row-1" }], error: null },
    insert: results.insert ?? { error: null },
    select: results.select ?? { data: [], error: null },
    delete: results.delete ?? { error: null }
  };
  const db = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      let op: keyof Results | null = null;
      for (const m of ["upsert", "update", "insert", "delete", "eq", "neq", "select", "order"]) {
        chain[m] = (...args: unknown[]) => {
          calls.push({ table, method: m, args });
          if (m === "update" || m === "insert" || m === "delete") op = m;
          else if (m === "select" && op === null) op = "select";
          return chain;
        };
      }
      chain["then"] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(resolved[op ?? "select"]).then(resolve, reject);
      return chain;
    }
  };
  return { db, calls };
}

type Client = Parameters<typeof setContactOverride>[4];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CONTACT_NUMBER_RE", () => {
  it("accepts E.164 and bare short codes, rejects everything else", () => {
    expect(CONTACT_NUMBER_RE.test("+16026951142")).toBe(true);
    expect(CONTACT_NUMBER_RE.test("73339")).toBe(true);
    expect(CONTACT_NUMBER_RE.test("5551234567")).toBe(false); // 10-digit bare
    expect(CONTACT_NUMBER_RE.test("+0123")).toBe(false);
    expect(CONTACT_NUMBER_RE.test("amy")).toBe(false);
    expect(CONTACT_NUMBER_RE.test("")).toBe(false);
  });
});

describe("setContactOverride", () => {
  it("relabels an existing contact (update) on the contacts table, preserving its type", async () => {
    const { db, calls } = makeDb(); // default update returns a matched row
    await setContactOverride(BIZ, "+16026951142", "  Amy Laidlaw  ", {}, db as unknown as Client);
    const update = calls.find((c) => c.method === "update");
    expect(update?.table).toBe("contacts");
    expect(update?.args[0]).toMatchObject({ display_name: "Amy Laidlaw" });
    // No `type` in an update payload — relabeling never changes classification.
    expect(update?.args[0]).not.toHaveProperty("type");
    const eqArgs = calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqArgs).toContainEqual(["business_id", BIZ]);
    expect(eqArgs).toContainEqual(["customer_e164", "+16026951142"]);
    // Existing row matched → no insert.
    expect(calls.some((c) => c.method === "insert")).toBe(false);
  });

  it("creates a manual contact (type 'other') when no row exists", async () => {
    const { db, calls } = makeDb({ update: { data: [], error: null } });
    await setContactOverride(BIZ, "73339", "ReferralExchange", {}, db as unknown as Client);
    const insert = calls.find((c) => c.method === "insert");
    expect(insert?.table).toBe("contacts");
    expect(insert?.args[0]).toMatchObject({
      business_id: BIZ,
      customer_e164: "73339",
      display_name: "ReferralExchange",
      type: "other"
    });
  });

  it("rejects invalid numbers", async () => {
    const { db } = makeDb();
    await expect(
      setContactOverride(BIZ, "not-a-number", "Amy", {}, db as unknown as Client)
    ).rejects.toThrow(/invalid number/);
  });

  it("rejects blank and over-long names", async () => {
    const { db } = makeDb();
    await expect(
      setContactOverride(BIZ, "+16026951142", "   ", {}, db as unknown as Client)
    ).rejects.toThrow(/1-120 characters/);
    await expect(
      setContactOverride(BIZ, "+16026951142", "x".repeat(121), {}, db as unknown as Client)
    ).rejects.toThrow(/1-120 characters/);
  });

  it("surfaces update errors", async () => {
    const { db } = makeDb({ update: { error: { message: "rls denied" } } });
    await expect(
      setContactOverride(BIZ, "+16026951142", "Amy", {}, db as unknown as Client)
    ).rejects.toThrow(/setContactOverride: rls denied/);
  });

  it("writes a trimmed email when one is provided", async () => {
    const { db, calls } = makeDb();
    await setContactOverride(
      BIZ,
      "+16026951142",
      "Amy",
      { email: "  amy@acme.com " },
      db as unknown as Client
    );
    const update = calls.find((c) => c.method === "update");
    expect(update?.args[0]).toMatchObject({ email: "amy@acme.com" });
  });

  it("clears the email when null is passed", async () => {
    const { db, calls } = makeDb();
    await setContactOverride(
      BIZ,
      "+16026951142",
      "Amy",
      { email: null },
      db as unknown as Client
    );
    const update = calls.find((c) => c.method === "update");
    expect(update?.args[0]).toMatchObject({ email: null });
  });

  it("leaves email untouched on a name-only save (no email key)", async () => {
    const { db, calls } = makeDb();
    await setContactOverride(BIZ, "+16026951142", "Amy", {}, db as unknown as Client);
    const update = calls.find((c) => c.method === "update");
    expect(update?.args[0]).not.toHaveProperty("email");
  });

  it("uses the default service client when none is injected", async () => {
    const { db } = makeDb();
    defaultClientSpy.mockReturnValue(db);
    await setContactOverride(BIZ, "+16026951142", "Amy");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("listContactOverrides", () => {
  it("returns manual (non-customer) rows scoped by business, newest-edited first", async () => {
    const rows = [
      {
        e164: "+16026951142",
        name: "Amy",
        email: "amy@acme.com",
        type: "other",
        updated_at: "2026-06-29T00:00:00Z"
      }
    ];
    const { db, calls } = makeDb({ select: { data: rows, error: null } });
    const out = await listContactOverrides(BIZ, db as unknown as Client);
    expect(out).toEqual(rows);
    expect(calls.find((c) => c.method === "eq")?.args).toEqual(["business_id", BIZ]);
    // Filters out real customer profiles so the list stays "other contacts".
    expect(calls.find((c) => c.method === "neq")?.args).toEqual(["type", "customer"]);
    expect(calls.find((c) => c.method === "order")?.args).toEqual([
      "updated_at",
      { ascending: false }
    ]);
  });

  it("returns [] when the query yields null data", async () => {
    const { db } = makeDb({ select: { data: null, error: null } });
    await expect(listContactOverrides(BIZ, db as unknown as Client)).resolves.toEqual([]);
  });

  it("surfaces list errors", async () => {
    const { db } = makeDb({ select: { error: { message: "nope" } } });
    await expect(listContactOverrides(BIZ, db as unknown as Client)).rejects.toThrow(
      /listContactOverrides: nope/
    );
  });

  it("uses the default service client when none is injected", async () => {
    const { db } = makeDb({ select: { data: [], error: null } });
    defaultClientSpy.mockReturnValue(db);
    await listContactOverrides(BIZ);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("deleteContactOverride", () => {
  it("deletes a non-customer label scoped by business+number", async () => {
    const { db, calls } = makeDb();
    await deleteContactOverride(BIZ, "73339", db as unknown as Client);
    expect(calls.find((c) => c.method === "delete")?.table).toBe("contacts");
    const eqArgs = calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqArgs).toContainEqual(["business_id", BIZ]);
    expect(eqArgs).toContainEqual(["customer_e164", "73339"]);
    // Never deletes a customer profile (its memory) via the label API.
    expect(calls.find((c) => c.method === "neq")?.args).toEqual(["type", "customer"]);
  });

  it("surfaces delete errors", async () => {
    const { db } = makeDb({ delete: { error: { message: "boom" } } });
    await expect(
      deleteContactOverride(BIZ, "73339", db as unknown as Client)
    ).rejects.toThrow(/deleteContactOverride: boom/);
  });

  it("uses the default service client when none is injected", async () => {
    const { db } = makeDb();
    defaultClientSpy.mockReturnValue(db);
    await deleteContactOverride(BIZ, "73339");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});
