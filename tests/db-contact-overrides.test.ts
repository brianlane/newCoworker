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

type Result = { data?: unknown; error: { message: string } | null };

function makeDb(result: Result = { error: null }) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const db = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const m of ["upsert", "delete", "eq", "select", "order"]) {
        chain[m] = (...args: unknown[]) => {
          calls.push({ table, method: m, args });
          return chain;
        };
      }
      chain["then"] = (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject);
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
  it("upserts a trimmed name keyed by business+number", async () => {
    const { db, calls } = makeDb();
    await setContactOverride(BIZ, "+16026951142", "  Amy Laidlaw  ", {}, db as unknown as Client);
    const upsert = calls.find((c) => c.method === "upsert");
    expect(upsert?.table).toBe("contact_overrides");
    expect(upsert?.args[0]).toMatchObject({
      business_id: BIZ,
      e164: "+16026951142",
      name: "Amy Laidlaw"
    });
    expect(upsert?.args[1]).toEqual({ onConflict: "business_id,e164" });
  });

  it("accepts short codes", async () => {
    const { db, calls } = makeDb();
    await setContactOverride(BIZ, "73339", "ReferralExchange", {}, db as unknown as Client);
    expect(calls.some((c) => c.method === "upsert")).toBe(true);
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

  it("surfaces upsert errors", async () => {
    const { db } = makeDb({ error: { message: "rls denied" } });
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
    const upsert = calls.find((c) => c.method === "upsert");
    expect(upsert?.args[0]).toMatchObject({ email: "amy@acme.com" });
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
    const upsert = calls.find((c) => c.method === "upsert");
    expect(upsert?.args[0]).toMatchObject({ email: null });
  });

  it("leaves email untouched on a name-only save (no email key)", async () => {
    const { db, calls } = makeDb();
    await setContactOverride(BIZ, "+16026951142", "Amy", {}, db as unknown as Client);
    const upsert = calls.find((c) => c.method === "upsert");
    expect(upsert?.args[0]).not.toHaveProperty("email");
  });

  it("uses the default service client when none is injected", async () => {
    const { db } = makeDb();
    defaultClientSpy.mockReturnValue(db);
    await setContactOverride(BIZ, "+16026951142", "Amy");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("listContactOverrides", () => {
  it("returns rows scoped by business, newest-edited first", async () => {
    const rows = [
      { e164: "+16026951142", name: "Amy", email: "amy@acme.com", updated_at: "2026-06-29T00:00:00Z" }
    ];
    const { db, calls } = makeDb({ data: rows, error: null });
    const out = await listContactOverrides(BIZ, db as unknown as Client);
    expect(out).toEqual(rows);
    expect(calls.find((c) => c.method === "eq")?.args).toEqual(["business_id", BIZ]);
    expect(calls.find((c) => c.method === "order")?.args).toEqual([
      "updated_at",
      { ascending: false }
    ]);
  });

  it("surfaces list errors", async () => {
    const { db } = makeDb({ error: { message: "nope" } });
    await expect(listContactOverrides(BIZ, db as unknown as Client)).rejects.toThrow(
      /listContactOverrides: nope/
    );
  });
});

describe("deleteContactOverride", () => {
  it("deletes the override scoped by business+number", async () => {
    const { db, calls } = makeDb();
    await deleteContactOverride(BIZ, "73339", db as unknown as Client);
    expect(calls.find((c) => c.method === "delete")?.table).toBe("contact_overrides");
    const eqArgs = calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqArgs).toContainEqual(["business_id", BIZ]);
    expect(eqArgs).toContainEqual(["e164", "73339"]);
  });

  it("surfaces delete errors", async () => {
    const { db } = makeDb({ error: { message: "boom" } });
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
