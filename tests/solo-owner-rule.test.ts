/**
 * Lockstep pin for the Deno solo-owner rule
 * (supabase/functions/_shared/solo_owner.ts) against its Next-side twins:
 * `pickImplicitContactOwner` (src/lib/contacts/owner-attribution.ts) and
 * `businessOwnerNumbers` (src/lib/db/contact-names.ts).
 *
 * The two sides cannot import each other (Deno vs Next bundles), so parity
 * is behavioral: one fixture matrix runs through BOTH implementations and
 * must produce identical accept/reject decisions and identical identities.
 * If you change either side, this file is what tells you to change the
 * other.
 *
 * One deliberate divergence, pinned here rather than papered over: a client
 * that THROWS makes `soloOwnerNumbers`/`resolveSoloOwner` return []/null
 * (routing must never throw), while the Node reader propagates. PostgREST
 *-style `{ error }` results behave identically on both sides (the failed
 * source contributes nothing).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  pickSoloOwner,
  resolveSoloOwner,
  soloOwnerNumbers,
  type SoloRosterRow
} from "../supabase/functions/_shared/solo_owner";
import { pickImplicitContactOwner } from "@/lib/contacts/owner-attribution";
import { businessOwnerNumbers } from "@/lib/db/contact-names";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OWNER_PHONE = "+16026951142";
const OTHER_PHONE = "+15555550102";

const owner = (over: Partial<SoloRosterRow> = {}): SoloRosterRow => ({
  id: "mem-owner",
  name: "Brian",
  phone_e164: OWNER_PHONE,
  email: "brian@example.com",
  active: true,
  ...over
});

type Result = { data: unknown; error: { message: string } | null };

/** Chainable per-table stub, the db-contact-names.test.ts pattern. */
function makeDb(perTable: Record<string, Result>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const db = {
    from(table: string) {
      const result = perTable[table] ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "maybeSingle"]) {
        chain[m] = (...args: unknown[]) => {
          calls.push({ table, method: m, args });
          return chain;
        };
      }
      chain["then"] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);
      return chain;
    }
  };
  return { db, calls };
}

const ownerNumberTables = (over: Record<string, Result> = {}): Record<string, Result> => ({
  business_telnyx_settings: { data: { forward_to_e164: OWNER_PHONE }, error: null },
  notification_preferences: { data: { phone_number: "+16028053377" }, error: null },
  businesses: { data: { phone: "(480) 703-9575" }, error: null },
  ...over
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("pickSoloOwner is lockstep with pickImplicitContactOwner", () => {
  /** Each case runs through BOTH rules; identity fields must agree. */
  const matrix: Array<{
    label: string;
    members: SoloRosterRow[];
    ownerNumbers: string[];
    accepts: boolean;
    name?: string;
  }> = [
    {
      label: "sole active member whose phone is an owner number",
      members: [owner()],
      ownerNumbers: [OWNER_PHONE],
      accepts: true,
      name: "Brian"
    },
    {
      label: "solo assistant (phone not an owner number)",
      members: [owner({ id: "mem-a", name: "Dana", phone_e164: OTHER_PHONE })],
      ownerNumbers: [OWNER_PHONE],
      accepts: false
    },
    {
      label: "two active members",
      members: [owner(), owner({ id: "mem-2", phone_e164: OTHER_PHONE })],
      ownerNumbers: [OWNER_PHONE],
      accepts: false
    },
    { label: "empty roster", members: [], ownerNumbers: [OWNER_PHONE], accepts: false },
    {
      label: "inactive-only roster",
      members: [owner({ active: false })],
      ownerNumbers: [OWNER_PHONE],
      accepts: false
    },
    {
      label: "hired then offboarded: inactive row does not break the count",
      members: [owner(), owner({ id: "mem-x", phone_e164: OTHER_PHONE, active: false })],
      ownerNumbers: [OWNER_PHONE],
      accepts: true,
      name: "Brian"
    },
    {
      label: "blank name falls back to Owner",
      members: [owner({ name: "   " })],
      ownerNumbers: [OWNER_PHONE],
      accepts: true,
      name: "Owner"
    },
    {
      label: "null name falls back to Owner",
      members: [owner({ name: null })],
      ownerNumbers: [OWNER_PHONE],
      accepts: true,
      name: "Owner"
    },
    {
      label: "no owner numbers on file",
      members: [owner()],
      ownerNumbers: [],
      accepts: false
    },
    {
      label: "sole member with an empty phone",
      members: [owner({ phone_e164: "" })],
      ownerNumbers: [OWNER_PHONE],
      accepts: false
    }
  ];

  for (const c of matrix) {
    it(c.label, () => {
      const deno = pickSoloOwner(c.members, c.ownerNumbers);
      // The Node rule requires string phone/boolean active; normalize the
      // shared fixtures the way its callers (roster reads) guarantee.
      const node = pickImplicitContactOwner(
        c.members.map((m) => ({
          id: m.id,
          name: m.name ?? null,
          phone_e164: m.phone_e164 ?? "",
          active: m.active === true
        })),
        c.ownerNumbers
      );
      expect(Boolean(deno)).toBe(c.accepts);
      expect(Boolean(node)).toBe(c.accepts);
      if (c.accepts) {
        expect(deno).not.toBeNull();
        expect(node).not.toBeNull();
        expect(deno?.memberId).toBe(node?.id);
        expect(deno?.name).toBe(node?.name);
        expect(deno?.name).toBe(c.name);
      }
    });
  }

  it("carries the roster phone and a trimmed email (Deno-only fields)", () => {
    const out = pickSoloOwner([owner({ email: "  brian@example.com  " })], [OWNER_PHONE]);
    expect(out).toEqual({
      memberId: "mem-owner",
      name: "Brian",
      phone: OWNER_PHONE,
      email: "brian@example.com"
    });
  });

  it("null and blank emails both resolve to null", () => {
    expect(pickSoloOwner([owner({ email: null })], [OWNER_PHONE])?.email).toBeNull();
    expect(pickSoloOwner([owner({ email: "   " })], [OWNER_PHONE])?.email).toBeNull();
  });

  it("a missing phone field declines even when active count is one", () => {
    const noPhone = owner();
    delete (noPhone as Record<string, unknown>).phone_e164;
    expect(pickSoloOwner([noPhone], [OWNER_PHONE])).toBeNull();
  });
});

describe("soloOwnerNumbers is lockstep with businessOwnerNumbers", () => {
  type NodeClient = NonNullable<Parameters<typeof businessOwnerNumbers>[1]>;

  const bothSides = async (perTable: Record<string, Result>) => {
    const deno = await soloOwnerNumbers(makeDb(perTable).db, BIZ);
    const node = await businessOwnerNumbers(BIZ, makeDb(perTable).db as unknown as NodeClient);
    return { deno, node };
  };

  it("returns the three sources in order: forward cell, alert phone, business phone", async () => {
    const { deno, node } = await bothSides(ownerNumberTables());
    expect(deno).toEqual([OWNER_PHONE, "+16028053377", "+14807039575"]);
    expect(node).toEqual(deno);
  });

  it("coerces free-text and bare-digit forms the same way on both sides", async () => {
    const { deno, node } = await bothSides(
      ownerNumberTables({
        business_telnyx_settings: { data: { forward_to_e164: "6026951142" }, error: null },
        notification_preferences: { data: { phone_number: "1 (602) 805-3377" }, error: null },
        businesses: { data: { phone: "+525512345678" }, error: null }
      })
    );
    expect(deno).toEqual(["+16026951142", "+16028053377", "+525512345678"]);
    expect(node).toEqual(deno);
  });

  it("skips null, empty, and uncoercible sources on both sides", async () => {
    const { deno, node } = await bothSides(
      ownerNumberTables({
        business_telnyx_settings: { data: { forward_to_e164: null }, error: null },
        notification_preferences: { data: { phone_number: "12345" }, error: null }
      })
    );
    expect(deno).toEqual(["+14807039575"]);
    expect(node).toEqual(deno);
  });

  it("a failed source contributes nothing on both sides", async () => {
    const { deno, node } = await bothSides(
      ownerNumberTables({
        business_telnyx_settings: { data: null, error: { message: "boom" } }
      })
    );
    expect(deno).toEqual(["+16028053377", "+14807039575"]);
    expect(node).toEqual(deno);
  });

  it("all sources failed or absent yields [] on both sides", async () => {
    const { deno, node } = await bothSides({
      business_telnyx_settings: { data: null, error: { message: "boom" } },
      notification_preferences: { data: null, error: null },
      businesses: { data: null, error: null }
    });
    expect(deno).toEqual([]);
    expect(node).toEqual(deno);
  });

  it("deliberate divergence: a throwing client yields [] here (Node propagates)", async () => {
    const throwing = {
      from() {
        throw new Error("connection reset");
      }
    };
    await expect(soloOwnerNumbers(throwing, BIZ)).resolves.toEqual([]);
  });
});

describe("resolveSoloOwner", () => {
  it("resolves the solo owner reading roster then owner numbers", async () => {
    const { db, calls } = makeDb({
      ai_flow_team_members: { data: [owner()], error: null },
      ...ownerNumberTables()
    });
    const out = await resolveSoloOwner(db, BIZ);
    expect(out).toEqual({
      memberId: "mem-owner",
      name: "Brian",
      phone: OWNER_PHONE,
      email: "brian@example.com"
    });
    expect(calls.some((c) => c.table === "ai_flow_team_members")).toBe(true);
  });

  it("reuses caller-held members without a roster query", async () => {
    const { db, calls } = makeDb(ownerNumberTables());
    const out = await resolveSoloOwner(db, BIZ, [owner()]);
    expect(out?.memberId).toBe("mem-owner");
    expect(calls.some((c) => c.table === "ai_flow_team_members")).toBe(false);
  });

  it("skips the owner-number reads entirely when the active count is not one", async () => {
    const { db, calls } = makeDb({
      ai_flow_team_members: {
        data: [owner(), owner({ id: "mem-2", phone_e164: OTHER_PHONE })],
        error: null
      }
    });
    const out = await resolveSoloOwner(db, BIZ);
    expect(out).toBeNull();
    expect(calls.some((c) => c.table === "business_telnyx_settings")).toBe(false);
    expect(calls.some((c) => c.table === "notification_preferences")).toBe(false);
    expect(calls.some((c) => c.table === "businesses")).toBe(false);
  });

  it("null roster data reads as an empty roster", async () => {
    const { db } = makeDb({ ai_flow_team_members: { data: null, error: null } });
    expect(await resolveSoloOwner(db, BIZ)).toBeNull();
  });

  it("a roster read error yields null, never a throw", async () => {
    const { db } = makeDb({
      ai_flow_team_members: { data: null, error: { message: "boom" } }
    });
    expect(await resolveSoloOwner(db, BIZ)).toBeNull();
  });

  it("a solo assistant resolves to null even with owner numbers readable", async () => {
    const { db } = makeDb({
      ai_flow_team_members: {
        data: [owner({ id: "mem-a", name: "Dana", phone_e164: OTHER_PHONE })],
        error: null
      },
      ...ownerNumberTables()
    });
    expect(await resolveSoloOwner(db, BIZ)).toBeNull();
  });

  it("a throwing client yields null, never a throw", async () => {
    const throwing = {
      from() {
        throw new Error("connection reset");
      }
    };
    expect(await resolveSoloOwner(throwing, BIZ)).toBeNull();
  });
});
