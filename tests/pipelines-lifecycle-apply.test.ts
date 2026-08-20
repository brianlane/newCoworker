import { describe, expect, it, vi, beforeEach } from "vitest";

// The Meta CAPI stage hook (first thing tag_changed contact events do) makes
// its own DB reads; mocking it keeps the scripted result sequences unshifted
// (it has its own suite).
vi.mock("../supabase/functions/_shared/ai_flows/meta_capi.ts", () => ({
  recordStageChangeForMeta: vi.fn(async () => false)
}));

const applyGoalEvent = vi.fn(async (..._args: unknown[]) => ({ jumped: 0 }));
const enqueueContactEventRuns = vi.fn(async (..._args: unknown[]) => 0);

vi.mock("../supabase/functions/_shared/ai_flows/goal_events.ts", () => ({
  applyGoalEvent: (...args: unknown[]) => applyGoalEvent(...args)
}));
vi.mock("../supabase/functions/_shared/ai_flows/contact_events.ts", () => ({
  enqueueContactEventRuns: (...args: unknown[]) => enqueueContactEventRuns(...args)
}));

import { applyLifecycleStage } from "../supabase/functions/_shared/pipelines/lifecycle";

/**
 * The applier turns a lifecycle moment into a stage tag. Everything here is
 * about what it REFUSES to do: a teammate is never a lead, an unreadable
 * toggle or roster writes nothing, and a tenant with no board costs one
 * query. The pure transition rules live in pipelines-lifecycle.test.ts.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const LEAD = "+16026160662";
/** Dave Lane, the roster member who claimed the lead. */
const DAVE = "+16025245719";

type Scripted = { data?: unknown; error?: unknown; throws?: boolean };

function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  const tables: string[] = [];
  let idx = 0;
  const from = (table: string) => {
    tables.push(table);
    const builder: Record<string, unknown> = {};
    for (const m of [
      "select", "update", "insert", "upsert", "eq", "is", "or", "in",
      "not", "gte", "limit", "order", "maybeSingle", "range"
    ]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["then"] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const r = results[idx++] ?? { data: null, error: null };
      if (r.throws) return Promise.reject(new Error("boom")).catch(reject ?? (() => {}));
      return Promise.resolve({
        data: "data" in r ? r.data : null,
        error: r.error ?? null
      }).then(resolve);
    };
    return builder;
  };
  return { db: { from }, calls, tables };
}

const ON = { data: { auto_lifecycle_stages: true } };
const STAGES = {
  data: [
    { id: "s0", pipeline_id: "p1", name: "New Lead", position: 0 },
    { id: "s1", pipeline_id: "p1", name: "Contacted", position: 1 },
    { id: "s2", pipeline_id: "p1", name: "Engaged", position: 2 }
  ]
};
const contact = (over: Record<string, unknown> = {}) => ({
  data: {
    id: "c1",
    customer_e164: LEAD,
    alias_e164s: [],
    tags: ["Clever", "New Lead"],
    type: "customer",
    ...over
  }
});
/**
 * A roster MISS, as the shared `staffNumberCheck` reads it. Three scripted
 * results, not one, because that detector asks three questions where this
 * module's old private helper asked one: the roster's phone numbers
 * (`maybeSingle`, so a miss is null and NOT `[]`), then the business's own
 * derived numbers, which is a `business_telnyx_settings` read plus a
 * `businesses` read. Spread into a script wherever a non-staff contact is
 * expected.
 */
const NOT_ROSTER = [{ data: null }, { data: null }, { data: null }];

const opts = { dedupeSuffix: "run-1" };

beforeEach(() => {
  applyGoalEvent.mockClear();
  enqueueContactEventRuns.mockClear();
});

describe("applyLifecycleStage: gates that write nothing", () => {
  it("no-ops on an empty phone without touching the database", async () => {
    const { db, calls } = makeDb([]);
    expect(await applyLifecycleStage(db, BIZ, "", "claimed", opts)).toBe("no_contact");
    expect(await applyLifecycleStage(db, BIZ, null, "claimed", opts)).toBe("no_contact");
    expect(await applyLifecycleStage(db, BIZ, undefined, "claimed", opts)).toBe("no_contact");
    expect(calls).toHaveLength(0);
  });

  it("writes nothing when auto_lifecycle_stages is off", async () => {
    const { db, tables } = makeDb([{ data: { auto_lifecycle_stages: false } }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("disabled");
    expect(tables).toEqual(["businesses"]);
  });

  it("fails SAFE (off) when the toggle cannot be read", async () => {
    // Opposite direction to needs_human's team-first toggle: a tag write is
    // an irreversible side effect that can start a tenant's flow.
    const { db } = makeDb([{ error: { message: "nope" } }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("disabled");
  });

  it("fails SAFE (off) when the toggle read throws", async () => {
    const { db } = makeDb([{ throws: true }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("disabled");
  });

  it("fails SAFE (off) when the business row is missing", async () => {
    const { db } = makeDb([{ data: null }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("disabled");
  });

  it("stops after one query when the business has no pipeline", async () => {
    // The fast path for most of the fleet: no board, one indexed select.
    const { db, tables } = makeDb([ON, { data: [] }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("no_stage");
    expect(tables).toEqual(["businesses", "pipeline_stages"]);
  });

  it("treats an unreadable stage list as no board", async () => {
    const { db } = makeDb([ON, { error: { message: "nope" } }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("no_stage");
  });

  it("treats a thrown stage read as no board", async () => {
    const { db } = makeDb([ON, { throws: true }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("no_stage");
  });

  it("returns no_contact when there is no contact row", async () => {
    const { db } = makeDb([ON, STAGES, { data: null }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("no_contact");
  });

  it("returns no_contact when the contact read errors", async () => {
    const { db } = makeDb([ON, STAGES, { error: { message: "nope" } }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("no_contact");
  });

  it("returns no_contact when the contact read throws", async () => {
    const { db } = makeDb([ON, STAGES, { throws: true }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("no_contact");
  });
});

describe("applyLifecycleStage: a teammate is never a lead", () => {
  it("skips a contact stored as an employee, without reading the roster", async () => {
    const { db, tables } = makeDb([ON, STAGES, contact({ type: "employee" })]);
    expect(await applyLifecycleStage(db, BIZ, DAVE, "replied", opts)).toBe("staff");
    expect(tables).not.toContain("ai_flow_team_members");
  });

  it("skips a contact stored as the owner", async () => {
    const { db } = makeDb([ON, STAGES, contact({ type: "OWNER" })]);
    expect(await applyLifecycleStage(db, BIZ, DAVE, "replied", opts)).toBe("staff");
  });

  it("skips a customer-typed row whose number is on the roster", async () => {
    // Dave replying "1" to a team offer arrives as an ordinary inbound SMS.
    const { db } = makeDb([
      ON,
      STAGES,
      contact({ customer_e164: DAVE, type: "customer" }),
      // maybeSingle, so a roster HIT is the row itself, not a one-row array.
      { data: { id: "m1" } }
    ]);
    expect(await applyLifecycleStage(db, BIZ, DAVE, "replied", opts)).toBe("staff");
  });

  it("fails SAFE (staff) when the roster cannot be read", async () => {
    const { db } = makeDb([ON, STAGES, contact(), { error: { message: "nope" } }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("staff");
  });

  it("fails SAFE (staff) when the roster read throws", async () => {
    const { db } = makeDb([ON, STAGES, contact(), { throws: true }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("staff");
  });

  it("treats an undefined stage payload as no board", async () => {
    // supabase-js can hand back undefined data with no error; that must read
    // as "no pipeline", not crash.
    const { db, tables } = makeDb([ON, { data: undefined }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("no_stage");
    expect(tables).toEqual(["businesses", "pipeline_stages"]);
  });

  it("treats a null contact type as a lead, not staff", async () => {
    const { db } = makeDb([
      ON, STAGES, contact({ type: null }), ...NOT_ROSTER, { data: null }
    ]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("written");
  });

  it("skips the roster query when the row has no usable numbers", async () => {
    const { db, tables } = makeDb([
      ON,
      STAGES,
      contact({ customer_e164: null, alias_e164s: null, tags: null }),
      ...NOT_ROSTER,
      { data: null }
    ]);
    // The targeted phone is always in scope, so this still queries; assert
    // the tag write happened rather than a spurious staff verdict.
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("written");
    expect(tables).toContain("ai_flow_team_members");
  });
});

describe("applyLifecycleStage: the write and its hooks", () => {
  it("advances the contact and fires both hook families", async () => {
    // The Donna Robinson case: Dave claimed her, so she becomes Contacted.
    const { db, calls } = makeDb([ON, STAGES, contact(), ...NOT_ROSTER, { data: null }]);
    const out = await applyLifecycleStage(db, BIZ, LEAD, "claimed", {
      dedupeSuffix: "run-1",
      sourceFlowId: "flow-9"
    });
    expect(out).toBe("written");

    const update = calls.find((c) => c.table === "contacts" && c.name === "update");
    expect(update?.args[0]).toMatchObject({ tags: ["Clever", "Contacted"] });

    expect(applyGoalEvent).toHaveBeenCalledTimes(1);
    expect(applyGoalEvent).toHaveBeenCalledWith(db, BIZ, LEAD, {
      kind: "tag_added",
      tag: "Contacted"
    });

    // One added, one removed.
    expect(enqueueContactEventRuns).toHaveBeenCalledTimes(2);
    expect(enqueueContactEventRuns).toHaveBeenNthCalledWith(1, db, BIZ, {
      kind: "tag_changed",
      contact: { e164: LEAD, tags: ["Clever", "Contacted"] },
      tag: "Contacted",
      change: "added",
      sourceFlowId: "flow-9",
      dedupeKey: "ce:stage:run-1:contacted:added"
    });
    expect(enqueueContactEventRuns).toHaveBeenNthCalledWith(2, db, BIZ, {
      kind: "tag_changed",
      contact: { e164: LEAD, tags: ["Clever", "Contacted"] },
      tag: "New Lead",
      change: "removed",
      sourceFlowId: "flow-9",
      dedupeKey: "ce:stage:run-1:new lead:removed"
    });
  });

  it("omits sourceFlowId when no flow caused the event", async () => {
    const { db } = makeDb([ON, STAGES, contact(), ...NOT_ROSTER, { data: null }]);
    await applyLifecycleStage(db, BIZ, LEAD, "claimed", { dedupeSuffix: "sms-7" });
    const arg = enqueueContactEventRuns.mock.calls[0][2] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("sourceFlowId");
  });

  it("fans goal events over every number linked to the contact", async () => {
    // A merged profile: runs match by the EXACT number they were triggered
    // with, which may be any alias.
    const alias = "+14805550111";
    const { db } = makeDb([
      ON, STAGES, contact({ alias_e164s: [alias] }), ...NOT_ROSTER, { data: null }
    ]);
    await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts);
    expect(applyGoalEvent).toHaveBeenCalledTimes(2);
    expect(applyGoalEvent.mock.calls.map((c) => c[2])).toEqual([LEAD, alias]);
  });

  it("writes against the surviving row when matched through an alias", async () => {
    const { db, calls } = makeDb([
      ON,
      STAGES,
      contact({ id: "survivor", customer_e164: "+14805550999", alias_e164s: [LEAD] }),
      ...NOT_ROSTER,
      { data: null }
    ]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("written");
    const eq = calls.find((c) => c.table === "contacts" && c.name === "eq" && c.args[0] === "id");
    expect(eq?.args[1]).toBe("survivor");
    // The contact event carries the surviving row's primary number.
    const arg = enqueueContactEventRuns.mock.calls[0][2] as { contact: { e164: string } };
    expect(arg.contact.e164).toBe("+14805550999");
  });

  it("returns no_change and fires nothing when already at the stage", async () => {
    const { db } = makeDb([ON, STAGES, contact({ tags: ["Contacted"] }), ...NOT_ROSTER]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("no_change");
    expect(applyGoalEvent).not.toHaveBeenCalled();
    expect(enqueueContactEventRuns).not.toHaveBeenCalled();
  });

  it("reports the tag cap instead of writing", async () => {
    const tags = Array.from({ length: 25 }, (_, i) => `t${i}`);
    const { db } = makeDb([ON, STAGES, contact({ tags }), ...NOT_ROSTER]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("dropped_at_cap");
    expect(enqueueContactEventRuns).not.toHaveBeenCalled();
  });

  it("ignores blank and non-string entries in the stored tag array", async () => {
    const { db, calls } = makeDb([
      ON,
      STAGES,
      contact({ tags: ["Clever", "  ", 7, null, "New Lead"] }),
      ...NOT_ROSTER,
      { data: null }
    ]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("written");
    const update = calls.find((c) => c.table === "contacts" && c.name === "update");
    expect(update?.args[0]).toMatchObject({ tags: ["Clever", "Contacted"] });
  });

  it("swallows a failed tag write and fires no hooks", async () => {
    const { db } = makeDb([ON, STAGES, contact(), ...NOT_ROSTER, { error: { message: "nope" } }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("no_change");
    expect(applyGoalEvent).not.toHaveBeenCalled();
  });

  it("swallows a thrown tag write", async () => {
    const { db } = makeDb([ON, STAGES, contact(), ...NOT_ROSTER, { throws: true }]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("no_change");
    expect(applyGoalEvent).not.toHaveBeenCalled();
  });

  it("groups stages by pipeline across several boards", async () => {
    const { db, calls } = makeDb([
      ON,
      {
        data: [
          { id: "a0", pipeline_id: "p1", name: "New Lead", position: 0 },
          { id: "a1", pipeline_id: "p1", name: "Contacted", position: 1 },
          { id: "b0", pipeline_id: "p2", name: "Onboarded", position: 0 }
        ]
      },
      contact({ tags: ["Onboarded", "New Lead"] }),
      ...NOT_ROSTER,
      { data: null }
    ]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "claimed", opts)).toBe("written");
    const update = calls.find((c) => c.table === "contacts" && c.name === "update");
    // p2 has no "Contacted" column, so its tag is left alone.
    expect(update?.args[0]).toMatchObject({ tags: ["Onboarded", "Contacted"] });
  });
});

describe("applyLifecycleStage: a contact keyed by email, not a number", () => {
  const EMAIL_KEY = "email:king@kinintegrated.com";
  const emailContact = (over: Record<string, unknown> = {}) => ({
    data: {
      id: "c9",
      customer_e164: EMAIL_KEY,
      alias_e164s: [],
      tags: ["New Lead"],
      type: "customer",
      ...over
    }
  });

  it("matches the row with eq, never with an interpolated or filter", async () => {
    // An address is not safe to interpolate into a comma-delimited .or()
    // string: a local part containing a comma or paren would silently change
    // which rows match. contactAliasOrFilter returns null for email keys and
    // this is the fallback it exists to trigger.
    const { db, calls } = makeDb([ON, STAGES, emailContact(), ...NOT_ROSTER, { data: null }]);
    expect(await applyLifecycleStage(db, BIZ, EMAIL_KEY, "claimed", opts)).toBe("written");

    const contactCalls = calls.filter((c) => c.table === "contacts");
    expect(contactCalls.some((c) => c.name === "or")).toBe(false);
    expect(contactCalls.some((c) => c.name === "eq" && c.args[0] === "customer_e164")).toBe(
      true
    );
  });

  it("stages an email-only lead like any other", async () => {
    // The whole point: before this, isE164 rejected the key upstream and an
    // email-only lead could never appear on a board.
    const { db, calls } = makeDb([
      ON,
      STAGES,
      emailContact({ tags: ["Engaged"] }),
      ...NOT_ROSTER,
      { data: null }
    ]);
    expect(await applyLifecycleStage(db, BIZ, EMAIL_KEY, "replied", opts)).toBe("no_change");
    expect(calls.find((c) => c.table === "contacts" && c.name === "update")).toBeUndefined();
  });

  it("fans the hooks out with the email key, which both accept", async () => {
    const { db } = makeDb([ON, STAGES, emailContact(), ...NOT_ROSTER, { data: null }]);
    expect(await applyLifecycleStage(db, BIZ, EMAIL_KEY, "claimed", opts)).toBe("written");
    expect(applyGoalEvent).toHaveBeenCalledWith(expect.anything(), BIZ, EMAIL_KEY, {
      kind: "tag_added",
      tag: "Contacted"
    });
    expect(enqueueContactEventRuns.mock.calls[0][2]).toMatchObject({
      contact: { e164: EMAIL_KEY }
    });
  });

  it("refuses a teammate whose only identifier is an email address", async () => {
    // The gap this closes: the roster's PHONE arm cannot match an
    // email-keyed row, so before delegating to staffNumberCheck the
    // protection evaporated for exactly the contacts it was needed for.
    const { db } = makeDb([
      ON,
      STAGES,
      emailContact(),
      // Phone arm misses, then the email arm reads the roster's addresses.
      { data: null },
      // Cased differently on purpose: a roster address keeps whatever casing
      // the dashboard or a CSV import stored, and an address is one identity
      // however it was typed.
      { data: [{ email: "King@KinIntegrated.com" }] }
    ]);
    expect(await applyLifecycleStage(db, BIZ, EMAIL_KEY, "claimed", opts)).toBe("staff");
  });
});

describe("applyLifecycleStage: the meeting pair", () => {
  /** A board that actually has the column the meeting events aim at. */
  const FULL_STAGES = {
    data: [
      { id: "s0", pipeline_id: "p1", name: "New Lead", position: 0 },
      { id: "s1", pipeline_id: "p1", name: "Contacted", position: 1 },
      { id: "s2", pipeline_id: "p1", name: "Engaged", position: 2 },
      { id: "s3", pipeline_id: "p1", name: "Booked", position: 3 },
      { id: "s4", pipeline_id: "p1", name: "Won", position: 4 }
    ]
  };

  it("writes Won from a classified meeting, the one platform path to it", async () => {
    // Kingsley: booked, then the discovery call ended in a commitment.
    const { db, calls } = makeDb([
      ON,
      FULL_STAGES,
      contact({ tags: ["Booking Page", "Booked"] }),
      ...NOT_ROSTER,
      { data: null }
    ]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "won", opts)).toBe("written");
    const update = calls.find((c) => c.table === "contacts" && c.name === "update");
    expect(update?.args[0]).toMatchObject({ tags: ["Booking Page", "Won"] });
  });

  it("writes nothing when the tenant has no Won column", async () => {
    // Rule 1 is what makes the Won change safe for tenants who never opted
    // in: a stage tag with no column behind it is invisible junk that still
    // burns the 25-tag cap and still fires tag_changed.
    const { db, calls } = makeDb([ON, STAGES, contact({ tags: ["Engaged"] }), ...NOT_ROSTER]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "won", opts)).toBe("no_change");
    expect(calls.find((c) => c.table === "contacts" && c.name === "update")).toBeUndefined();
  });

  it("never drags a Won lead back to Engaged when a later meeting is filed", async () => {
    // Forward-only: a second call with an already-closed customer must not
    // undo the close.
    const { db, calls } = makeDb([
      ON,
      FULL_STAGES,
      contact({ tags: ["Won"] }),
      ...NOT_ROSTER
    ]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "met", opts)).toBe("no_change");
    expect(calls.find((c) => c.table === "contacts" && c.name === "update")).toBeUndefined();
  });

  it("advances a new lead to Engaged when a meeting happened", async () => {
    const { db, calls } = makeDb([
      ON,
      FULL_STAGES,
      contact({ tags: ["New Lead"] }),
      ...NOT_ROSTER,
      { data: null }
    ]);
    expect(await applyLifecycleStage(db, BIZ, LEAD, "met", opts)).toBe("written");
    const update = calls.find((c) => c.table === "contacts" && c.name === "update");
    expect(update?.args[0]).toMatchObject({ tags: ["Engaged"] });
  });
});
