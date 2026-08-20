import { describe, expect, it } from "vitest";

import { upsertContactIdentity } from "@/lib/contacts/identity";

/**
 * Result-shape coverage for the shared identity core. The CSV importer's
 * suite (tests/csv-contacts.test.ts) drives every fold/race path through the
 * real caller; these tests pin what the core RETURNS (kind/via/contactId/
 * before) and the readColumns plumbing the Follow Up Boss importer relies on.
 * Same scripted-builder approach as that suite.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";

type CallLog = { name: string; args: unknown[] };
type Scripted = { data?: unknown; error?: unknown };

function makeDb(results: Scripted[]) {
  const log: { table: string; calls: CallLog[] }[] = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const rpc = async (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    return next();
  };
  const from = (table: string) => {
    const calls: CallLog[] = [];
    log.push({ table, calls });
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "insert", "update", "delete", "eq", "or", "ilike", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ name: m, args });
        return builder;
      };
    }
    builder["maybeSingle"] = async () => {
      calls.push({ name: "maybeSingle", args: [] });
      return next();
    };
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from, rpc } as never, log, rpcCalls };
}

const PATCH = { updated_at: "2026-08-20T00:00:00Z", display_name: "Jane" };

describe("upsertContactIdentity", () => {
  it("update path: returns the matched row's id and the readColumns snapshot", async () => {
    const { db, log } = makeDb([
      { data: { id: "row-1", tags: ["VIP"], lead_source: "Zillow" }, error: null },
      { error: null }
    ]);
    const result = await upsertContactIdentity(db, BIZ, {
      key: "+16025551234",
      email: "jane@example.com",
      patch: PATCH,
      insert: {},
      readColumns: ["tags", "lead_source"]
    });
    expect(result).toEqual({
      kind: "updated",
      via: "update",
      contactId: "row-1",
      before: { id: "row-1", tags: ["VIP"], lead_source: "Zillow" }
    });
    expect(log[0].calls.find((c) => c.name === "select")?.args).toEqual(["id, tags, lead_source"]);
  });

  it("dedupes readColumns already in the base select", async () => {
    const { db, log } = makeDb([{ data: { id: "row-1" }, error: null }, { error: null }]);
    await upsertContactIdentity(db, BIZ, {
      key: "+16025551234",
      email: null,
      patch: PATCH,
      insert: {},
      readColumns: ["id", "tags"]
    });
    expect(log[0].calls.find((c) => c.name === "select")?.args).toEqual(["id, tags"]);
  });

  it("insert path: returns the created id from the insert's select", async () => {
    const { db, log } = makeDb([
      { data: null, error: null }, // lookup misses
      { data: [{ id: "new-1" }], error: null } // insert returns the row
    ]);
    const result = await upsertContactIdentity(db, BIZ, {
      key: "+16025551234",
      email: null,
      patch: PATCH,
      insert: { display_name: "Jane" }
    });
    expect(result).toEqual({ kind: "created", via: "insert", contactId: "new-1", before: null });
    expect(log[1].calls.find((c) => c.name === "insert")?.args[0]).toEqual({
      business_id: BIZ,
      customer_e164: "+16025551234",
      display_name: "Jane"
    });
    expect(log[1].calls.some((c) => c.name === "select")).toBe(true);
  });

  it("insert path: a row without an id still resolves (contactId null)", async () => {
    const { db } = makeDb([
      { data: null, error: null },
      { data: [{}], error: null }
    ]);
    const result = await upsertContactIdentity(db, BIZ, {
      key: "+16025551234",
      email: null,
      patch: PATCH,
      insert: {}
    });
    expect(result.contactId).toBeNull();
  });

  it("fold_merge path: reports the survivor's id and pre-patch row", async () => {
    const survivor = { id: "match-1", customer_e164: "+15550009999", type: "customer", tags: ["a"] };
    const { db, log, rpcCalls } = makeDb([
      { data: null, error: null }, // keyed lookup misses
      { data: [survivor], error: null }, // email match
      { error: null }, // bare temp insert
      { error: null }, // patch survivor
      { error: null } // merge rpc
    ]);
    const result = await upsertContactIdentity(db, BIZ, {
      key: "+16025551234",
      email: "jane@example.com",
      patch: PATCH,
      insert: {},
      readColumns: ["tags"]
    });
    expect(result).toEqual({
      kind: "updated",
      via: "fold_merge",
      contactId: "match-1",
      before: survivor
    });
    expect(log[1].calls.find((c) => c.name === "select")?.args).toEqual([
      "id, customer_e164, type, tags"
    ]);
    expect(rpcCalls).toEqual([
      {
        fn: "merge_customer_memories",
        args: { p_business_id: BIZ, p_from_e164: "+16025551234", p_into_e164: "+15550009999" }
      }
    ]);
  });

  it("fold_patch path: an email-keyed row patches the match in place", async () => {
    const match = { id: "match-2", customer_e164: "+15550008888", type: "customer" };
    const { db, rpcCalls } = makeDb([
      { data: null, error: null },
      { data: [match], error: null },
      { error: null } // patch only
    ]);
    const result = await upsertContactIdentity(db, BIZ, {
      key: "email:jane@example.com",
      email: "jane@example.com",
      patch: PATCH,
      insert: {}
    });
    expect(result).toEqual({
      kind: "updated",
      via: "fold_patch",
      contactId: "match-2",
      before: match
    });
    expect(rpcCalls).toEqual([]);
  });

  it("fold_promoted path: a failed merge promotes the temp row and returns its id", async () => {
    const { db } = makeDb([
      { data: null, error: null },
      { data: [{ id: "match-1", customer_e164: "+15550009999", type: "customer" }], error: null },
      { error: null }, // bare insert
      { error: null }, // patch survivor
      { error: { message: "target gone" } }, // merge fails
      { data: [{ id: "promoted-1" }], error: null } // promote update
    ]);
    const result = await upsertContactIdentity(db, BIZ, {
      key: "+16025551234",
      email: "jane@example.com",
      patch: PATCH,
      insert: {}
    });
    expect(result).toEqual({
      kind: "created",
      via: "fold_promoted",
      contactId: "promoted-1",
      before: null
    });
  });

  it("fold_promoted path: promote select without an id yields contactId null", async () => {
    const { db } = makeDb([
      { data: null, error: null },
      { data: [{ id: "match-1", customer_e164: "+15550009999", type: "customer" }], error: null },
      { error: null },
      { error: null },
      { error: { message: "target gone" } },
      { data: null, error: null }
    ]);
    const result = await upsertContactIdentity(db, BIZ, {
      key: "+16025551234",
      email: "jane@example.com",
      patch: PATCH,
      insert: {}
    });
    expect(result.via).toBe("fold_promoted");
    expect(result.contactId).toBeNull();
  });

  it("raced fold: retries as an update and reports raced_update with the row", async () => {
    const { db } = makeDb([
      { data: null, error: null },
      { data: [{ id: "match-1", customer_e164: "+15550009999", type: "customer" }], error: null },
      { error: { code: "23505", message: "dup" } }, // bare insert loses the race
      { data: { id: "raced-1", tags: [] }, error: null }, // retry lookup finds it
      { error: null } // retry update
    ]);
    const result = await upsertContactIdentity(db, BIZ, {
      key: "+16025551234",
      email: "jane@example.com",
      patch: PATCH,
      insert: {},
      readColumns: ["tags"]
    });
    expect(result).toEqual({
      kind: "updated",
      via: "raced_update",
      contactId: "raced-1",
      before: { id: "raced-1", tags: [] }
    });
  });

  it("declaredType other than customer skips the fold and creates directly", async () => {
    const { db, log } = makeDb([
      { data: null, error: null },
      { data: [{ id: "new-2" }], error: null }
    ]);
    const result = await upsertContactIdentity(db, BIZ, {
      key: "+16025551234",
      email: "jane@example.com",
      patch: PATCH,
      insert: {},
      declaredType: "tester"
    });
    expect(result.via).toBe("insert");
    // No ilike email-match query ever ran.
    expect(log.every((t) => !t.calls.some((c) => c.name === "ilike"))).toBe(true);
  });

  it("surfaces the concurrent-vanish race as the re-import error", async () => {
    const { db } = makeDb([
      { data: null, error: null }, // lookup misses
      { data: [], error: null }, // no email match
      { error: { code: "23505", message: "dup" } }, // insert loses the race
      { data: null, error: null } // retry lookup misses again
    ]);
    await expect(
      upsertContactIdentity(db, BIZ, {
        key: "+16025551234",
        email: "jane@example.com",
        patch: PATCH,
        insert: {}
      })
    ).rejects.toThrow("A concurrent change kept +16025551234 from being saved; re-import this row.");
  });
});
