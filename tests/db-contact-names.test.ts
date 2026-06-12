import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import { resolveContactNames } from "@/lib/db/contact-names";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";

type Result = { data: unknown; error: { message: string } | null };

/**
 * Chainable stub whose terminal result depends on the table queried —
 * resolveContactNames hits `ai_flow_team_members` and `customer_memories`
 * in parallel with different chain shapes (`.in` only on the team query).
 */
function makeDb(perTable: Record<string, Result>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const db = {
    from(table: string) {
      const result = perTable[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "or"]) {
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

type Client = Parameters<typeof resolveContactNames>[2];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveContactNames", () => {
  it("returns an empty map without querying when no numbers are given", async () => {
    const { db } = makeDb({});
    const out = await resolveContactNames(BIZ, [], db as unknown as Client);
    expect(out.size).toBe(0);
  });

  it("maps roster team members as employees and named customer profiles as customers", async () => {
    const { db } = makeDb({
      ai_flow_team_members: {
        data: [{ phone_e164: "+15550000001", name: "Dave Lane" }],
        error: null
      },
      customer_memories: {
        data: [
          { customer_e164: "+15550000002", alias_e164s: [], display_name: "Liz Wharton" }
        ],
        error: null
      }
    });
    const out = await resolveContactNames(
      BIZ,
      ["+15550000001", "+15550000002", "+15550000003"],
      db as unknown as Client
    );
    expect(out.get("+15550000001")).toEqual({ name: "Dave Lane", kind: "employee" });
    expect(out.get("+15550000002")).toEqual({ name: "Liz Wharton", kind: "customer" });
    expect(out.has("+15550000003")).toBe(false);
  });

  it("lets an employee entry override a stale auto-created customer profile for the same number", async () => {
    const { db } = makeDb({
      ai_flow_team_members: {
        data: [{ phone_e164: "+15550000001", name: "Dave Lane" }],
        error: null
      },
      customer_memories: {
        data: [
          { customer_e164: "+15550000001", alias_e164s: [], display_name: "Some Customer" }
        ],
        error: null
      }
    });
    const out = await resolveContactNames(BIZ, ["+15550000001"], db as unknown as Client);
    expect(out.get("+15550000001")).toEqual({ name: "Dave Lane", kind: "employee" });
  });

  it("matches merged-away aliases to the profile's display name", async () => {
    const { db } = makeDb({
      customer_memories: {
        data: [
          {
            customer_e164: "+15550000010",
            alias_e164s: ["+15550000011"],
            display_name: "Terry"
          }
        ],
        error: null
      }
    });
    const out = await resolveContactNames(BIZ, ["+15550000011"], db as unknown as Client);
    expect(out.get("+15550000011")).toEqual({ name: "Terry", kind: "customer" });
  });

  it("skips blank and 'Unknown caller' placeholder display names", async () => {
    const { db } = makeDb({
      customer_memories: {
        data: [
          { customer_e164: "+15550000020", alias_e164s: [], display_name: "Unknown caller" },
          { customer_e164: "+15550000021", alias_e164s: [], display_name: "   " },
          { customer_e164: "+15550000022", alias_e164s: [], display_name: null }
        ],
        error: null
      }
    });
    const out = await resolveContactNames(
      BIZ,
      ["+15550000020", "+15550000021", "+15550000022"],
      db as unknown as Client
    );
    expect(out.size).toBe(0);
  });

  it("tolerates null data payloads and null alias arrays / names", async () => {
    const a = makeDb({
      ai_flow_team_members: { data: null, error: null },
      customer_memories: { data: null, error: null }
    });
    expect(
      (await resolveContactNames(BIZ, ["+1555"], a.db as unknown as Client)).size
    ).toBe(0);

    const b = makeDb({
      ai_flow_team_members: {
        data: [{ phone_e164: "+15550000030", name: null }],
        error: null
      },
      customer_memories: {
        data: [
          { customer_e164: "+15550000031", alias_e164s: null, display_name: "Pat" }
        ],
        error: null
      }
    });
    const out = await resolveContactNames(
      BIZ,
      ["+15550000030", "+15550000031"],
      b.db as unknown as Client
    );
    expect(out.has("+15550000030")).toBe(false);
    expect(out.get("+15550000031")).toEqual({ name: "Pat", kind: "customer" });
  });

  it("ignores customer profiles whose numbers were not asked about", async () => {
    const { db } = makeDb({
      customer_memories: {
        data: [
          {
            customer_e164: "+15550000040",
            alias_e164s: ["+15550000041"],
            display_name: "Unrelated"
          }
        ],
        error: null
      }
    });
    const out = await resolveContactNames(BIZ, ["+15550000099"], db as unknown as Client);
    expect(out.size).toBe(0);
  });

  it("dedupes input numbers and ignores empty strings", async () => {
    const { db, calls } = makeDb({});
    await resolveContactNames(BIZ, ["+1555", "+1555", ""], db as unknown as Client);
    const inCall = calls.find((c) => c.table === "ai_flow_team_members" && c.method === "in");
    expect(inCall?.args).toEqual(["phone_e164", ["+1555"]]);
  });

  it("only matches ACTIVE roster members, mirroring the inbound webhook's employee gate", async () => {
    const { db, calls } = makeDb({});
    await resolveContactNames(BIZ, ["+1555"], db as unknown as Client);
    const eqCalls = calls.filter(
      (c) => c.table === "ai_flow_team_members" && c.method === "eq"
    );
    expect(eqCalls.map((c) => c.args)).toContainEqual(["active", true]);
  });

  it("filters customer_memories in SQL by primary number OR alias overlap (no full-table scan)", async () => {
    const { db, calls } = makeDb({});
    await resolveContactNames(BIZ, ["+1555", "+1666"], db as unknown as Client);
    const orCall = calls.find((c) => c.table === "customer_memories" && c.method === "or");
    expect(orCall?.args).toEqual([
      "customer_e164.in.(+1555,+1666),alias_e164s.ov.{+1555,+1666}"
    ]);
  });

  it("throws on team query errors", async () => {
    const { db } = makeDb({
      ai_flow_team_members: { data: null, error: { message: "team rls" } }
    });
    await expect(
      resolveContactNames(BIZ, ["+1555"], db as unknown as Client)
    ).rejects.toThrow(/resolveContactNames: team rls/);
  });

  it("throws on customer query errors", async () => {
    const { db } = makeDb({
      customer_memories: { data: null, error: { message: "cust rls" } }
    });
    await expect(
      resolveContactNames(BIZ, ["+1555"], db as unknown as Client)
    ).rejects.toThrow(/resolveContactNames: cust rls/);
  });

  it("falls back to createSupabaseServiceClient when no client is injected", async () => {
    const { db } = makeDb({});
    defaultClientSpy.mockReturnValue(db);
    await resolveContactNames(BIZ, ["+1555"]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});
