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
 * resolveContactNames hits `ai_flow_team_members` and the unified `contacts`
 * table in parallel with different chain shapes (`.in` only on the team query).
 * Manual labels are `contacts` rows whose `name_source` is 'manual' (the name
 * wins over the derived owner/employee overlay regardless of `type`).
 */
function makeDb(perTable: Record<string, Result>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const db = {
    from(table: string) {
      const result = perTable[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "or", "maybeSingle"]) {
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
      contacts: {
        data: [
          {
            customer_e164: "+15550000002",
            alias_e164s: [],
            display_name: "Liz Wharton",
            type: "customer"
          }
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
      contacts: {
        data: [
          {
            customer_e164: "+15550000001",
            alias_e164s: [],
            display_name: "Some Customer",
            type: "customer"
          }
        ],
        error: null
      }
    });
    const out = await resolveContactNames(BIZ, ["+15550000001"], db as unknown as Client);
    expect(out.get("+15550000001")).toEqual({ name: "Dave Lane", kind: "employee" });
  });

  it("a manual label on an employee's number wins over the roster name but keeps kind 'employee'", async () => {
    const { db } = makeDb({
      ai_flow_team_members: {
        data: [{ phone_e164: "+15550000001", name: "Dave Lane" }],
        error: null
      },
      contacts: {
        data: [
          {
            customer_e164: "+15550000001",
            alias_e164s: [],
            display_name: "Dave (cell)",
            type: "other",
            name_source: "manual"
          }
        ],
        error: null
      }
    });
    const out = await resolveContactNames(BIZ, ["+15550000001"], db as unknown as Client);
    expect(out.get("+15550000001")).toEqual({
      name: "Dave (cell)",
      kind: "employee",
      override: true
    });
  });

  it("matches merged-away aliases to the profile's display name", async () => {
    const { db } = makeDb({
      contacts: {
        data: [
          {
            customer_e164: "+15550000010",
            alias_e164s: ["+15550000011"],
            display_name: "Terry",
            type: "customer"
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
      contacts: {
        data: [
          {
            customer_e164: "+15550000020",
            alias_e164s: [],
            display_name: "Unknown caller",
            type: "customer"
          },
          { customer_e164: "+15550000021", alias_e164s: [], display_name: "   ", type: "customer" },
          { customer_e164: "+15550000022", alias_e164s: [], display_name: null, type: "customer" }
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
      contacts: { data: null, error: null }
    });
    expect(
      (await resolveContactNames(BIZ, ["+1555"], a.db as unknown as Client)).size
    ).toBe(0);

    const b = makeDb({
      ai_flow_team_members: {
        data: [{ phone_e164: "+15550000030", name: null }],
        error: null
      },
      contacts: {
        data: [
          { customer_e164: "+15550000031", alias_e164s: null, display_name: "Pat", type: "customer" }
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
      contacts: {
        data: [
          {
            customer_e164: "+15550000040",
            alias_e164s: ["+15550000041"],
            display_name: "Unrelated",
            type: "customer"
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

  it("filters contacts in SQL by primary number OR alias overlap (no full-table scan)", async () => {
    const { db, calls } = makeDb({});
    await resolveContactNames(BIZ, ["+1555", "+1666"], db as unknown as Client);
    const orCall = calls.find((c) => c.table === "contacts" && c.method === "or");
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

  it("throws on contacts query errors", async () => {
    const { db } = makeDb({
      contacts: { data: null, error: { message: "cust rls" } }
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

  it("labels the Safe Mode forward number as the owner, beating roster and customer entries", async () => {
    const { db } = makeDb({
      ai_flow_team_members: {
        data: [{ phone_e164: "+16026951142", name: "Amy L" }],
        error: null
      },
      contacts: {
        data: [
          {
            customer_e164: "+16026951142",
            alias_e164s: [],
            display_name: "Stale Profile",
            type: "customer"
          }
        ],
        error: null
      },
      businesses: { data: { owner_name: "Amy Laidlaw", phone: null }, error: null },
      business_telnyx_settings: { data: { forward_to_e164: "+16026951142" }, error: null },
      notification_preferences: { data: null, error: null }
    });
    const out = await resolveContactNames(BIZ, ["+16026951142"], db as unknown as Client);
    expect(out.get("+16026951142")).toEqual({ name: "Amy Laidlaw", kind: "owner" });
  });

  it("loose-normalizes the bare 10-digit alert phone and onboarding phone to +1 E.164", async () => {
    const { db } = makeDb({
      businesses: { data: { owner_name: "Amy Laidlaw", phone: "(602) 805-3377" }, error: null },
      business_telnyx_settings: { data: null, error: null },
      notification_preferences: { data: { phone_number: "6026951142" }, error: null }
    });
    const out = await resolveContactNames(
      BIZ,
      ["+16026951142", "+16028053377"],
      db as unknown as Client
    );
    expect(out.get("+16026951142")).toEqual({ name: "Amy Laidlaw", kind: "owner" });
    expect(out.get("+16028053377")).toEqual({ name: "Amy Laidlaw", kind: "owner" });
  });

  it("falls back to the label 'Owner' when owner_name is blank, and skips unparseable owner phone fields", async () => {
    const { db } = makeDb({
      businesses: { data: { owner_name: "   ", phone: "ext. 0" }, error: null },
      business_telnyx_settings: { data: { forward_to_e164: "+16026951142" }, error: null },
      notification_preferences: { data: { phone_number: "n/a" }, error: null }
    });
    const out = await resolveContactNames(BIZ, ["+16026951142"], db as unknown as Client);
    expect(out.get("+16026951142")).toEqual({ name: "Owner", kind: "owner" });
  });

  it("ignores owner numbers that are not among the asked-about threads (and tolerates a missing businesses row)", async () => {
    const { db } = makeDb({
      businesses: { data: null, error: null },
      business_telnyx_settings: { data: { forward_to_e164: "+16026951142" }, error: null },
      notification_preferences: { data: { phone_number: null }, error: null }
    });
    const out = await resolveContactNames(BIZ, ["+15550000099"], db as unknown as Client);
    expect(out.size).toBe(0);
  });

  it("manual label (non-customer contact) wins over the derived owner name but keeps the derived kind", async () => {
    const { db } = makeDb({
      businesses: { data: { owner_name: "Brian Lane", phone: null }, error: null },
      business_telnyx_settings: { data: { forward_to_e164: "+16026951142" }, error: null },
      notification_preferences: { data: null, error: null },
      contacts: {
        data: [
          {
            customer_e164: "+16026951142",
            alias_e164s: [],
            display_name: "Amy Laidlaw",
            type: "other",
            name_source: "manual"
          }
        ],
        error: null
      }
    });
    const out = await resolveContactNames(BIZ, ["+16026951142"], db as unknown as Client);
    expect(out.get("+16026951142")).toEqual({
      name: "Amy Laidlaw",
      kind: "owner",
      override: true
    });
  });

  it("labels a manual contact on an unidentified number (short-code lead source) as kind 'contact'", async () => {
    const { db } = makeDb({
      contacts: {
        data: [
          {
            customer_e164: "73339",
            alias_e164s: [],
            display_name: "ReferralExchange",
            type: "service",
            name_source: "manual"
          },
          { customer_e164: "+15550000088", alias_e164s: [], display_name: "", type: "other", name_source: "manual" },
          { customer_e164: "+15550000089", alias_e164s: [], display_name: null, type: "other", name_source: "manual" }
        ],
        error: null
      }
    });
    const out = await resolveContactNames(
      BIZ,
      ["73339", "+15550000088", "+15550000089"],
      db as unknown as Client
    );
    expect(out.get("73339")).toEqual({
      name: "ReferralExchange",
      kind: "contact",
      override: true
    });
    // Blank / null names are ignored rather than rendering "".
    expect(out.has("+15550000088")).toBe(false);
    expect(out.has("+15550000089")).toBe(false);
  });

  it("a manual name on a CUSTOMER-typed owner number sticks over the derived owner name (removed legacy: no more 'set type to other' workaround)", async () => {
    const { db } = makeDb({
      businesses: { data: { owner_name: "Amy Laidlaw", phone: null }, error: null },
      business_telnyx_settings: { data: { forward_to_e164: "+16026951142" }, error: null },
      notification_preferences: { data: null, error: null },
      contacts: {
        data: [
          {
            customer_e164: "+16026951142",
            alias_e164s: [],
            display_name: "Amy (personal cell)",
            type: "customer",
            name_source: "manual"
          }
        ],
        error: null
      }
    });
    const out = await resolveContactNames(BIZ, ["+16026951142"], db as unknown as Client);
    expect(out.get("+16026951142")).toEqual({
      name: "Amy (personal cell)",
      kind: "owner",
      override: true
    });
  });

  it("an AUTO name on a non-customer number still loses to the derived owner identity (provenance, not type, decides)", async () => {
    const { db } = makeDb({
      businesses: { data: { owner_name: "Amy Laidlaw", phone: null }, error: null },
      business_telnyx_settings: { data: { forward_to_e164: "+16026951142" }, error: null },
      notification_preferences: { data: null, error: null },
      contacts: {
        data: [
          {
            customer_e164: "+16026951142",
            alias_e164s: [],
            display_name: "Auto Captured",
            type: "service",
            name_source: "auto"
          }
        ],
        error: null
      }
    });
    const out = await resolveContactNames(BIZ, ["+16026951142"], db as unknown as Client);
    // No `override`: the auto name did not win, the derived owner name did.
    expect(out.get("+16026951142")).toEqual({ name: "Amy Laidlaw", kind: "owner" });
  });

  it("renders an auto name on a non-customer contact as kind 'contact' WITHOUT override (no identity to beat)", async () => {
    const { db } = makeDb({
      contacts: {
        data: [
          {
            customer_e164: "+15550000077",
            alias_e164s: [],
            display_name: "Vendor Co",
            type: "other",
            name_source: "auto"
          }
        ],
        error: null
      }
    });
    const out = await resolveContactNames(BIZ, ["+15550000077"], db as unknown as Client);
    expect(out.get("+15550000077")).toEqual({ name: "Vendor Co", kind: "contact" });
  });

  it("throws on owner-source query errors", async () => {
    const { db } = makeDb({
      business_telnyx_settings: { data: null, error: { message: "settings rls" } }
    });
    await expect(
      resolveContactNames(BIZ, ["+1555"], db as unknown as Client)
    ).rejects.toThrow(/resolveContactNames: settings rls/);
  });
});
