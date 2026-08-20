import { describe, expect, it, vi, beforeEach } from "vitest";

// The tag-write hooks have their own suites; here we only assert they are
// invoked with the right arguments, in the shared-mechanism shape.
const applyGoalEvent = vi.fn(async (..._args: unknown[]) => ({ jumpedRuns: 0 }));
const enqueueContactEventRuns = vi.fn(async (..._args: unknown[]) => 0);
vi.mock("../supabase/functions/_shared/ai_flows/goal_events.ts", () => ({
  applyGoalEvent: (...args: unknown[]) => applyGoalEvent(...args)
}));
vi.mock("../supabase/functions/_shared/ai_flows/contact_events.ts", () => ({
  enqueueContactEventRuns: (...args: unknown[]) => enqueueContactEventRuns(...args)
}));

// The solo-owner rule is pinned by tests/solo-owner-rule.test.ts; mocking it
// keeps the scripted result sequences here to the sweep's own reads.
const pickSoloOwner = vi.fn((..._args: unknown[]): { memberId: string } | null => null);
const soloOwnerNumbers = vi.fn(async (..._args: unknown[]): Promise<string[]> => []);
vi.mock("../supabase/functions/_shared/solo_owner.ts", () => ({
  pickSoloOwner: (...args: unknown[]) => pickSoloOwner(...args),
  soloOwnerNumbers: (...args: unknown[]) => soloOwnerNumbers(...args)
}));

import {
  CONTACT_PAGE,
  MAX_TAG_WRITES_PER_RUN,
  SEGMENT_PAGE,
  matchesSegmentFilters,
  parseSegmentActionFilters,
  planContactTagAdds,
  runSegmentActionSweep,
  type SegmentActionContactFacts
} from "../supabase/functions/_shared/segment_actions";

const NOW = Date.parse("2026-08-20T09:10:00.000Z");
const NOW_ISO = "2026-08-20T09:10:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const BIZ = "biz-a";
const UUID_EMP = "00000000-0000-0000-0000-0000000000aa";
const UUID_OTHER = "00000000-0000-0000-0000-0000000000bb";

type Scripted = { data?: unknown; error?: unknown };

/**
 * Scripted PostgREST stub (the pipelines-lifecycle-apply harness): each
 * awaited query consumes the next result, whatever the chained filters were,
 * and every call is recorded for assertions.
 */
function makeDb(
  results: Scripted[],
  opts: {
    // `skip` lets through that many uses of the table before throwing, so a
    // test can kill the run at the tag WRITE rather than at the page read.
    throwFrom?: { table: string; value: unknown; times: number; skip?: number };
  } = {}
) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  const tables: string[] = [];
  let idx = 0;
  const throwFrom = opts.throwFrom ? { skip: 0, ...opts.throwFrom } : null;
  const from = (table: string) => {
    if (throwFrom && throwFrom.table === table && throwFrom.times > 0) {
      if (throwFrom.skip > 0) {
        throwFrom.skip -= 1;
      } else {
        throwFrom.times -= 1;
        throw throwFrom.value;
      }
    }
    tables.push(table);
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "update", "insert", "eq", "in", "order", "range", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["then"] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const r = results[idx++] ?? { data: null, error: { message: "unscripted query" } };
      return Promise.resolve({
        data: "data" in r ? r.data : null,
        error: r.error ?? null
      }).then(resolve, reject);
    };
    return builder;
  };
  return { db: { from }, calls, tables };
}

const segRow = (over: Record<string, unknown> = {}) => ({
  id: "seg-1",
  business_id: BIZ,
  name: "Hot",
  filters: {},
  action_tag: "Follow up",
  ...over
});

const contactRow = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  customer_e164: "+15550001111",
  alias_e164s: [],
  tags: [],
  type: "customer",
  owner_employee_id: null,
  last_channel: "sms",
  last_interaction_at: null,
  total_interaction_count: 0,
  created_at: "2026-08-01T00:00:00.000Z",
  ...over
});

/**
 * The write-time re-read of contacts.tags. The sweep merges against the row
 * as it stands after the (slow) hooks rather than writing back the snapshot
 * it planned from, so every persisted contact costs one of these first.
 */
const reread = (tags: unknown = []) => ({ data: [{ tags }] });

beforeEach(() => {
  applyGoalEvent.mockClear();
  enqueueContactEventRuns.mockClear();
  pickSoloOwner.mockReset();
  pickSoloOwner.mockReturnValue(null);
  soloOwnerNumbers.mockReset();
  soloOwnerNumbers.mockResolvedValue([]);
});

describe("parseSegmentActionFilters", () => {
  it("fails closed on anything that is not a plain object", () => {
    expect(parseSegmentActionFilters(null)).toBeNull();
    expect(parseSegmentActionFilters([])).toBeNull();
    expect(parseSegmentActionFilters("junk")).toBeNull();
  });

  it("is strict: one unknown key invalidates the whole set", () => {
    expect(parseSegmentActionFilters({ bogus: 1 })).toBeNull();
  });

  it("an empty object is 'all contacts'", () => {
    expect(parseSegmentActionFilters({})).toEqual({});
  });

  it("parses and trims tagsAny; rejects malformed entries and lengths", () => {
    expect(parseSegmentActionFilters({ tagsAny: [" VIP "] })).toEqual({ tagsAny: ["VIP"] });
    expect(parseSegmentActionFilters({ tagsAny: "VIP" })).toBeNull();
    expect(parseSegmentActionFilters({ tagsAny: [42] })).toBeNull();
    expect(parseSegmentActionFilters({ tagsAny: ["  "] })).toBeNull();
    expect(parseSegmentActionFilters({ tagsAny: ["x".repeat(41)] })).toBeNull();
    expect(parseSegmentActionFilters({ tagsAny: [] })).toBeNull();
    expect(parseSegmentActionFilters({ tagsAny: Array.from({ length: 11 }, () => "t") })).toBeNull();
  });

  it("parses type against the unified classification enum", () => {
    expect(parseSegmentActionFilters({ type: "customer" })).toEqual({ type: "customer" });
    expect(parseSegmentActionFilters({ type: "bogus" })).toBeNull();
    expect(parseSegmentActionFilters({ type: 7 })).toBeNull();
  });

  it("parses ownerEmployeeId as a uuid or the literal 'none'", () => {
    expect(parseSegmentActionFilters({ ownerEmployeeId: "none" })).toEqual({
      ownerEmployeeId: "none"
    });
    expect(parseSegmentActionFilters({ ownerEmployeeId: UUID_EMP })).toEqual({
      ownerEmployeeId: UUID_EMP
    });
    expect(parseSegmentActionFilters({ ownerEmployeeId: "emp-1" })).toBeNull();
    expect(parseSegmentActionFilters({ ownerEmployeeId: 9 })).toBeNull();
  });

  it("parses and trims lastChannel within its length cap", () => {
    expect(parseSegmentActionFilters({ lastChannel: " sms " })).toEqual({ lastChannel: "sms" });
    expect(parseSegmentActionFilters({ lastChannel: 3 })).toBeNull();
    expect(parseSegmentActionFilters({ lastChannel: "  " })).toBeNull();
    expect(parseSegmentActionFilters({ lastChannel: "x".repeat(21) })).toBeNull();
  });

  it("parses the day-count fields as integers 1..365", () => {
    expect(parseSegmentActionFilters({ lastInteractionWithinDays: 7 })).toEqual({
      lastInteractionWithinDays: 7
    });
    expect(parseSegmentActionFilters({ lastInteractionWithinDays: "7" })).toBeNull();
    expect(parseSegmentActionFilters({ lastInteractionWithinDays: 0 })).toBeNull();
    expect(parseSegmentActionFilters({ lastInteractionOlderThanDays: 30 })).toEqual({
      lastInteractionOlderThanDays: 30
    });
    expect(parseSegmentActionFilters({ lastInteractionOlderThanDays: 366 })).toBeNull();
    expect(parseSegmentActionFilters({ createdWithinDays: 14 })).toEqual({
      createdWithinDays: 14
    });
    expect(parseSegmentActionFilters({ createdWithinDays: 1.5 })).toBeNull();
  });

  it("parses neverContacted as a real boolean only", () => {
    expect(parseSegmentActionFilters({ neverContacted: true })).toEqual({ neverContacted: true });
    expect(parseSegmentActionFilters({ neverContacted: "true" })).toBeNull();
  });
});

describe("matchesSegmentFilters (port parity with matchesSegment)", () => {
  const facts = (over: Partial<SegmentActionContactFacts> = {}): SegmentActionContactFacts => ({
    tags: ["VIP"],
    type: "customer",
    ownerEmployeeId: null,
    lastChannel: "sms",
    lastInteractionAt: new Date(NOW - 2 * DAY).toISOString(),
    totalInteractions: 3,
    createdAt: new Date(NOW - 10 * DAY).toISOString(),
    ...over
  });

  it("empty filters match everyone", () => {
    expect(matchesSegmentFilters(facts(), {}, NOW)).toBe(true);
  });

  it("tagsAny is case-insensitive ANY", () => {
    expect(matchesSegmentFilters(facts(), { tagsAny: ["vip"] }, NOW)).toBe(true);
    expect(matchesSegmentFilters(facts(), { tagsAny: ["Won"] }, NOW)).toBe(false);
  });

  it("type must equal", () => {
    expect(matchesSegmentFilters(facts(), { type: "customer" }, NOW)).toBe(true);
    expect(matchesSegmentFilters(facts(), { type: "tester" }, NOW)).toBe(false);
  });

  it("ownerEmployeeId: 'none' means unowned, an id must match", () => {
    expect(matchesSegmentFilters(facts(), { ownerEmployeeId: "none" }, NOW)).toBe(true);
    expect(
      matchesSegmentFilters(facts({ ownerEmployeeId: UUID_EMP }), { ownerEmployeeId: "none" }, NOW)
    ).toBe(false);
    expect(
      matchesSegmentFilters(facts({ ownerEmployeeId: UUID_EMP }), { ownerEmployeeId: UUID_EMP }, NOW)
    ).toBe(true);
    expect(
      matchesSegmentFilters(
        facts({ ownerEmployeeId: UUID_OTHER }),
        { ownerEmployeeId: UUID_EMP },
        NOW
      )
    ).toBe(false);
  });

  it("lastChannel compares case-insensitively, null never matches", () => {
    expect(matchesSegmentFilters(facts(), { lastChannel: "SMS" }, NOW)).toBe(true);
    expect(matchesSegmentFilters(facts({ lastChannel: null }), { lastChannel: "sms" }, NOW)).toBe(
      false
    );
  });

  it("activity windows: within needs a recent stamp, overdue passes never-contacted", () => {
    expect(matchesSegmentFilters(facts(), { lastInteractionWithinDays: 7 }, NOW)).toBe(true);
    expect(matchesSegmentFilters(facts(), { lastInteractionWithinDays: 1 }, NOW)).toBe(false);
    expect(
      matchesSegmentFilters(facts({ lastInteractionAt: null }), { lastInteractionWithinDays: 7 }, NOW)
    ).toBe(false);
    expect(matchesSegmentFilters(facts(), { lastInteractionOlderThanDays: 1 }, NOW)).toBe(true);
    expect(matchesSegmentFilters(facts(), { lastInteractionOlderThanDays: 30 }, NOW)).toBe(false);
    expect(
      matchesSegmentFilters(
        facts({ lastInteractionAt: null }),
        { lastInteractionOlderThanDays: 30 },
        NOW
      )
    ).toBe(true);
  });

  it("neverContacted matches on the interaction count", () => {
    expect(matchesSegmentFilters(facts({ totalInteractions: 0 }), { neverContacted: true }, NOW)).toBe(
      true
    );
    expect(matchesSegmentFilters(facts(), { neverContacted: true }, NOW)).toBe(false);
    expect(matchesSegmentFilters(facts(), { neverContacted: false }, NOW)).toBe(true);
  });

  it("createdWithinDays needs a parseable recent stamp", () => {
    expect(matchesSegmentFilters(facts(), { createdWithinDays: 14 }, NOW)).toBe(true);
    expect(matchesSegmentFilters(facts(), { createdWithinDays: 5 }, NOW)).toBe(false);
    expect(matchesSegmentFilters(facts({ createdAt: "" }), { createdWithinDays: 14 }, NOW)).toBe(
      false
    );
    expect(
      matchesSegmentFilters(facts({ createdAt: "not-a-date" }), { createdWithinDays: 14 }, NOW)
    ).toBe(false);
  });
});

describe("planContactTagAdds", () => {
  it("normalizes the stored list the way update_contact does", () => {
    const plan = planContactTagAdds(
      [" VIP ", "vip", "", 42, "x".repeat(45)] as unknown[],
      ["New"]
    );
    expect(plan.next).toEqual(["VIP", "x".repeat(40), "New"]);
    expect(plan.added).toEqual(["New"]);
  });

  it("treats a non-array stored value as no tags", () => {
    expect(planContactTagAdds(null, ["A"]).next).toEqual(["A"]);
  });

  it("reports an already-carried candidate instead of duplicating it", () => {
    const plan = planContactTagAdds(["Follow Up"], ["follow up"]);
    expect(plan.added).toEqual([]);
    expect(plan.alreadyCarried).toEqual(["follow up"]);
    expect(plan.next).toEqual(["Follow Up"]);
  });

  it("drops explicitly at the 25-tag row cap", () => {
    const stored = Array.from({ length: 25 }, (_, i) => `t${i}`);
    const plan = planContactTagAdds(stored, ["overflow"]);
    expect(plan.added).toEqual([]);
    expect(plan.droppedAtCap).toEqual(["overflow"]);
    expect(plan.next).toHaveLength(25);
  });
});

describe("runSegmentActionSweep", () => {
  it("does nothing on a fleet with no enabled actions (defaults in play)", async () => {
    const { db, calls } = makeDb([{ data: null }]);
    const result = await runSegmentActionSweep(db);
    expect(result).toMatchObject({ businesses: 0, segments: 0, tagsWritten: 0, errors: [] });
    const range = calls.find((c) => c.name === "range");
    expect(range?.args).toEqual([0, SEGMENT_PAGE - 1]);
  });

  it("records a listing failure and stops", async () => {
    const { db } = makeDb([{ error: { message: "boom" } }]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.errors).toEqual(["segment listing: boom"]);
    expect(result.businesses).toBe(0);
  });

  it("pages the enabled-segment listing in explicit chunks", async () => {
    const page1 = Array.from({ length: SEGMENT_PAGE }, (_, i) =>
      segRow({ id: `seg-${i}`, action_tag: null })
    );
    const page2 = [segRow({ id: "seg-b", business_id: "biz-b", action_tag: null })];
    const { db, calls } = makeDb([{ data: page1 }, { data: page2 }]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.businesses).toBe(2);
    expect(result.segments).toBe(SEGMENT_PAGE + 1);
    expect(result.invalidFilters).toBe(SEGMENT_PAGE + 1);
    const ranges = calls.filter((c) => c.name === "range").map((c) => c.args);
    expect(ranges).toEqual([
      [0, SEGMENT_PAGE - 1],
      [SEGMENT_PAGE, 2 * SEGMENT_PAGE - 1]
    ]);
  });

  it("skips invalid segments fail-closed and never reads contacts for them", async () => {
    const { db, tables } = makeDb([
      {
        data: [
          segRow({ id: "seg-bad", filters: { bogus: 1 } }),
          segRow({ id: "seg-tagless", action_tag: "   " })
        ]
      }
    ]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.invalidFilters).toBe(2);
    expect(result.errors).toEqual([
      'segment seg-bad ("Hot"): invalid stored filters, skipped',
      'segment seg-tagless ("Hot"): missing action tag, skipped'
    ]);
    expect(result.applied).toBe(0);
    expect(tables).toEqual(["contact_segments"]);
  });

  it("tags a matching contact through the shared event path and stamps the segment", async () => {
    const rows = [
      contactRow({ id: "c0", customer_e164: null }),
      contactRow({
        id: "c1",
        alias_e164s: ["+15550001111", "+15550002222", "", 42],
        tags: ["Existing"],
        type: null,
        total_interaction_count: null,
        created_at: null
      }),
      contactRow({ id: "c2", customer_e164: "+15550003333", tags: ["FOLLOW UP"] })
    ];
    const { db, calls } = makeDb([
      { data: [segRow()] },
      { data: rows },
      reread(["Existing"]), // c1 write-time re-read
      { data: null }, // c1 tag write
      { data: null } // stamp
    ]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result).toMatchObject({
      businesses: 1,
      segments: 1,
      applied: 1,
      contactsScanned: 2,
      tagsWritten: 1,
      alreadyTagged: 1,
      droppedAtTagCap: 0,
      cappedBusinesses: [],
      errors: []
    });

    const writes = calls.filter((c) => c.table === "contacts" && c.name === "update");
    expect(writes).toHaveLength(1);
    expect(writes[0].args[0]).toEqual({
      tags: ["Existing", "Follow up"],
      updated_at: NOW_ISO
    });
    // Goal events fan out over the unique linked numbers, all naming the same
    // application, so one run reachable by two of the contact's own numbers
    // cannot be jumped twice.
    expect(applyGoalEvent.mock.calls.map((c) => c[2])).toEqual([
      "+15550001111",
      "+15550002222"
    ]);
    for (const call of applyGoalEvent.mock.calls) {
      expect(call[3]).toEqual({
        kind: "tag_added",
        tag: "Follow up",
        dedupeKey: "ce:segact:seg-1:c1:follow up"
      });
    }
    expect(enqueueContactEventRuns).toHaveBeenCalledTimes(1);
    expect(enqueueContactEventRuns.mock.calls[0][2]).toEqual({
      kind: "tag_changed",
      contact: { e164: "+15550001111", tags: ["Existing", "Follow up"] },
      tag: "Follow up",
      change: "added",
      note: 'Smart List "Hot" nightly action',
      // No night in the key: it names the tag APPLICATION, so a repaired
      // retry on a later night dedupes against the first delivery.
      dedupeKey: "ce:segact:seg-1:c1:follow up"
    });

    const stamp = calls.find((c) => c.table === "contact_segments" && c.name === "update");
    expect(stamp?.args[0]).toEqual({ last_applied_at: NOW_ISO });
    const stampIn = calls.find((c) => c.table === "contact_segments" && c.name === "in");
    expect(stampIn?.args).toEqual(["id", ["seg-1"]]);
  });

  it("enqueues the automation BEFORE the tag column is persisted", async () => {
    // The carried tag is the sweep's only "already done" marker, so it has
    // to be the last thing written for a contact. Persisting it first would
    // let a run that died in between retire the contact for good with its
    // tag_changed never enqueued.
    const { db, calls } = makeDb([
      { data: [segRow()] },
      { data: [contactRow()] },
      reread(), // write-time re-read
      { data: null }, // tag write
      { data: null } // stamp
    ]);
    const contactWrites = () =>
      calls.filter((c) => c.table === "contacts" && c.name === "update").length;
    let writesAtEnqueue = -1;
    enqueueContactEventRuns.mockImplementationOnce(async () => {
      writesAtEnqueue = contactWrites();
      return 0;
    });
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.tagsWritten).toBe(1);
    expect(writesAtEnqueue).toBe(0);
    expect(contactWrites()).toBe(1);
  });

  it("merges at write time, keeping a tag another writer added while the hooks ran", async () => {
    // Announcing before persisting puts the slow hooks (a goal-event pass per
    // linked number, a flow listing per tag) between the page read and the
    // write. Writing back the planned snapshot would silently drop whatever
    // landed in that window: a teammate tagging from the dashboard, another
    // flow's update_contact, the lifecycle stager.
    const { db, calls } = makeDb([
      { data: [segRow()] },
      { data: [contactRow({ tags: ["Existing"] })] },
      reread(["Existing", "Teammate"]), // arrived while the hooks ran
      { data: null }, // write
      { data: null } // stamp
    ]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.tagsWritten).toBe(1);
    expect(result.errors).toEqual([]);
    const write = calls.find((c) => c.table === "contacts" && c.name === "update");
    expect(write?.args[0]).toEqual({
      tags: ["Existing", "Teammate", "Follow up"],
      updated_at: NOW_ISO
    });
    // The re-read is the row's tags only, by id.
    const selects = calls.filter((c) => c.table === "contacts" && c.name === "select");
    expect(selects[1].args[0]).toBe("tags");
    const eqs = calls.filter((c) => c.table === "contacts" && c.name === "eq");
    expect(eqs.some((c) => c.args[0] === "id" && c.args[1] === "c1")).toBe(true);
    // The announcement stays the picture from the read, deliberately: it has
    // to go out BEFORE the write for a half-finished night to be repairable.
    expect(enqueueContactEventRuns.mock.calls[0][2]).toMatchObject({
      contact: { e164: "+15550001111", tags: ["Existing", "Follow up"] }
    });
  });

  it("writes nothing when another writer landed the same tag first", async () => {
    const { db, calls } = makeDb([
      { data: [segRow()] },
      { data: [contactRow()] },
      reread(["FOLLOW UP"]), // the same tag, from someone else, mid-window
      { data: null } // stamp
    ]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.tagsWritten).toBe(0);
    expect(result.errors).toEqual([]);
    expect(calls.filter((c) => c.table === "contacts" && c.name === "update")).toHaveLength(0);
    // The hooks still fired, and the row does carry the tag, so what they
    // announced is true.
    expect(enqueueContactEventRuns).toHaveBeenCalledTimes(1);
  });

  it("counts a 25-tag-cap drop that only happens at write time", async () => {
    const full = Array.from({ length: 25 }, (_, i) => `t${i}`);
    const { db, calls } = makeDb([
      { data: [segRow()] },
      { data: [contactRow()] },
      reread(full), // the row filled up while the hooks ran
      { data: null } // stamp
    ]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.droppedAtTagCap).toBe(1);
    expect(result.tagsWritten).toBe(0);
    expect(result.errors).toEqual([]);
    expect(calls.filter((c) => c.table === "contacts" && c.name === "update")).toHaveLength(0);
  });

  it("never writes blind: an unreadable or vanished row is recorded, not clobbered", async () => {
    const down = makeDb([
      { data: [segRow()] },
      { data: [contactRow()] },
      { error: { message: "read down" } }, // the re-read fails
      { data: null } // stamp
    ]);
    const r1 = await runSegmentActionSweep(down.db, NOW);
    expect(r1.errors).toEqual(["business biz-a: tag re-read for contact c1: read down"]);
    expect(r1.tagsWritten).toBe(0);
    expect(down.calls.filter((c) => c.table === "contacts" && c.name === "update")).toHaveLength(0);

    // Deleted between the page read and the write: nothing to merge into.
    const gone = makeDb([
      { data: [segRow()] },
      { data: [contactRow()] },
      { data: [] }, // the row is no longer there
      { data: null } // stamp
    ]);
    const r2 = await runSegmentActionSweep(gone.db, NOW);
    expect(r2.errors).toEqual(["business biz-a: tag re-read for contact c1: row is gone"]);
    expect(gone.calls.filter((c) => c.table === "contacts" && c.name === "update")).toHaveLength(0);
  });

  it("a night that dies at the tag write repairs on the next one, with the same dedupe key", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Night 1: the automation is enqueued, then the process dies at the
      // column write (a 150s route cap, a pod restart: same outcome, no tag).
      // skip 2 lets the page read and the write-time re-read through.
      const night1 = makeDb([{ data: [segRow()] }, { data: [contactRow()] }, reread()], {
        throwFrom: { table: "contacts", value: new Error("pod killed"), times: 1, skip: 2 }
      });
      const r1 = await runSegmentActionSweep(night1.db, NOW);
      expect(r1.errors).toEqual(["business biz-a: sweep threw: pod killed"]);
      expect(r1.tagsWritten).toBe(0);
      expect(enqueueContactEventRuns).toHaveBeenCalledTimes(1);

      // Night 2 sees the same untagged contact and finishes the job. Its
      // enqueue carries the key night 1 used, which the ai_flow_runs
      // (flow_id, dedupe_key) index turns into a no-op, so the repair
      // cannot text the same person a second time.
      const night2 = makeDb([
        { data: [segRow()] },
        { data: [contactRow()] },
        reread(), // write-time re-read
        { data: null }, // tag write
        { data: null } // stamp
      ]);
      const r2 = await runSegmentActionSweep(night2.db, NOW + DAY);
      expect(r2.tagsWritten).toBe(1);
      expect(r2.errors).toEqual([]);
      expect(enqueueContactEventRuns).toHaveBeenCalledTimes(2);
      const keys = enqueueContactEventRuns.mock.calls.map(
        (c) => (c[2] as { dedupeKey: string }).dedupeKey
      );
      expect(keys).toEqual(["ce:segact:seg-1:c1:follow up", "ce:segact:seg-1:c1:follow up"]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("the repaired night's goal event names the same application, so it cannot jump twice", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Same crash as above, watched from the OTHER hook. applyGoalEvent
      // inserts nothing, so there is no unique index to catch a repeat: it
      // dedupes on the runs it would move, and it can only do that if both
      // nights hand it the same key. (That the key then stops the second
      // jump is pinned by tests/ai-flows-goal-events.test.ts.)
      const night1 = makeDb([{ data: [segRow()] }, { data: [contactRow()] }, reread()], {
        throwFrom: { table: "contacts", value: new Error("pod killed"), times: 1, skip: 2 }
      });
      await runSegmentActionSweep(night1.db, NOW);
      const night2 = makeDb([
        { data: [segRow()] },
        { data: [contactRow()] },
        reread(), // write-time re-read
        { data: null }, // tag write
        { data: null } // stamp
      ]);
      const r2 = await runSegmentActionSweep(night2.db, NOW + DAY);
      expect(r2.tagsWritten).toBe(1);
      // One delivery per night, both naming the tag APPLICATION rather than
      // the night it was attempted.
      expect(applyGoalEvent).toHaveBeenCalledTimes(2);
      expect(applyGoalEvent.mock.calls.map((c) => c[3])).toEqual([
        { kind: "tag_added", tag: "Follow up", dedupeKey: "ce:segact:seg-1:c1:follow up" },
        { kind: "tag_added", tag: "Follow up", dedupeKey: "ce:segact:seg-1:c1:follow up" }
      ]);
      // And the enqueue keeps carrying the same key, so the pair stays in
      // step: one application, one identity, both hooks.
      expect(enqueueContactEventRuns.mock.calls.map((c) => (c[2] as { dedupeKey: string }).dedupeKey))
        .toEqual(["ce:segact:seg-1:c1:follow up", "ce:segact:seg-1:c1:follow up"]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a normal repeat night fires nothing: the carried tag skips the contact", async () => {
    const { db, calls } = makeDb([
      { data: [segRow()] },
      { data: [contactRow({ tags: ["FOLLOW UP"] })] },
      { data: null } // stamp only; there is nothing to write
    ]);
    const result = await runSegmentActionSweep(db, NOW + DAY);
    expect(result).toMatchObject({
      tagsWritten: 0,
      alreadyTagged: 1,
      applied: 1,
      errors: []
    });
    expect(enqueueContactEventRuns).not.toHaveBeenCalled();
    expect(applyGoalEvent).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.table === "contacts" && c.name === "update")).toHaveLength(0);
  });

  it("de-duplicates a tag shared by two segments and still stamps every segment", async () => {
    const { db, calls } = makeDb([
      {
        data: [
          segRow({ id: "s1", action_tag: "Same" }),
          segRow({ id: "s2", action_tag: "SAME" }),
          segRow({ id: "s3", action_tag: "Other", filters: { tagsAny: ["nope"] } })
        ]
      },
      { data: [contactRow()] },
      reread(), // write-time re-read
      { data: null }, // write
      { data: null } // stamp
    ]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.tagsWritten).toBe(1);
    expect(result.applied).toBe(3);
    expect(enqueueContactEventRuns).toHaveBeenCalledTimes(1);
    // First segment wins the attribution for the shared tag identity.
    expect(enqueueContactEventRuns.mock.calls[0][2]).toMatchObject({
      tag: "Same",
      dedupeKey: "ce:segact:s1:c1:same"
    });
    const stampIn = calls.find((c) => c.table === "contact_segments" && c.name === "in");
    expect(stampIn?.args).toEqual(["id", ["s1", "s2", "s3"]]);
  });

  it("skips the business when a type/owner filter needs the roster and it is unreadable", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { db, tables } = makeDb([
        { data: [segRow({ filters: { type: "customer" } })] },
        { error: { message: "roster down" } }
      ]);
      const result = await runSegmentActionSweep(db, NOW);
      expect(result.errors).toEqual(["business biz-a: roster unreadable, skipped"]);
      expect(result.applied).toBe(0);
      expect(tables).toEqual(["contact_segments", "ai_flow_team_members"]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("mirrors the page's type overlay: owner numbers win, then the active roster", async () => {
    soloOwnerNumbers.mockResolvedValue(["+15550007777"]);
    const roster = [
      { id: "emp-1", name: "Dave", phone_e164: "+15550009999", email: null, active: true },
      { id: "emp-2", name: "NoPhone", phone_e164: null, email: null, active: true },
      { id: "emp-3", name: "Gone", phone_e164: "+15550008888", email: null, active: false }
    ];
    const contacts = [
      contactRow({ id: "cOwner", customer_e164: "+15550007777" }),
      contactRow({ id: "cEmp", customer_e164: "+15550009999" }),
      contactRow({ id: "cCust", customer_e164: "+15550001111" }),
      // An ex-teammate's number is NOT overlaid (active-only roster).
      contactRow({ id: "cGone", customer_e164: "+15550008888" })
    ];
    const { db } = makeDb([
      {
        data: [
          segRow({ id: "s-own", action_tag: "TagOwner", filters: { type: "owner" } }),
          segRow({ id: "s-emp", action_tag: "TagEmp", filters: { type: "employee" } }),
          segRow({ id: "s-cust", action_tag: "TagCust", filters: { type: "customer" } })
        ]
      },
      { data: roster },
      { data: contacts },
      reread(), // cOwner re-read
      { data: null }, // cOwner write
      reread(), // cEmp re-read
      { data: null }, // cEmp write
      reread(), // cCust re-read
      { data: null }, // cCust write
      reread(), // cGone re-read
      { data: null }, // cGone write
      { data: null } // stamp
    ]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.tagsWritten).toBe(4);
    const byContact = new Map(
      enqueueContactEventRuns.mock.calls.map((c) => [
        (c[2] as { contact: { e164: string } }).contact.e164,
        (c[2] as { tag: string }).tag
      ])
    );
    expect(byContact.get("+15550007777")).toBe("TagOwner");
    expect(byContact.get("+15550009999")).toBe("TagEmp");
    expect(byContact.get("+15550001111")).toBe("TagCust");
    expect(byContact.get("+15550008888")).toBe("TagCust");
  });

  it("treats a null roster page as an empty roster", async () => {
    const { db } = makeDb([
      { data: [segRow({ filters: { type: "customer" } })] },
      { data: null }, // roster: null page
      { data: [contactRow()] },
      reread(), // write-time re-read
      { data: null }, // write
      { data: null } // stamp
    ]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.tagsWritten).toBe(1);
    expect(pickSoloOwner).toHaveBeenCalledWith([], []);
  });

  it("mirrors the implicit-owner rule: an unclaimed contact resolves to the solo owner", async () => {
    pickSoloOwner.mockReturnValue({ memberId: UUID_EMP });
    const contacts = [
      contactRow({ id: "cImplicit", owner_employee_id: null }),
      contactRow({ id: "cOther", customer_e164: "+15550004444", owner_employee_id: UUID_OTHER }),
      contactRow({ id: "cStamped", customer_e164: "+15550005555", owner_employee_id: UUID_EMP })
    ];
    const { db } = makeDb([
      {
        data: [
          segRow({ id: "s-mine", action_tag: "Mine", filters: { ownerEmployeeId: UUID_EMP } }),
          segRow({ id: "s-none", action_tag: "Unowned", filters: { ownerEmployeeId: "none" } })
        ]
      },
      { data: [{ id: UUID_EMP, name: "Solo", phone_e164: "+15550009999", email: null, active: true }] },
      { data: contacts },
      reread(), // cImplicit re-read
      { data: null }, // cImplicit write
      reread(), // cStamped re-read
      { data: null }, // cStamped write
      { data: null } // stamp
    ]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.tagsWritten).toBe(2);
    const tagged = enqueueContactEventRuns.mock.calls.map(
      (c) => (c[2] as { contact: { e164: string } }).contact.e164
    );
    // The implicit owner makes "none" unmatchable, exactly like the page.
    expect(tagged).toEqual(["+15550001111", "+15550005555"]);
  });

  it("aborts a business without stamping when a contact page cannot be read", async () => {
    const { db, calls } = makeDb([
      { data: [segRow()] },
      { error: { message: "down" } }
    ]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.errors).toEqual(["business biz-a: contact page read: down"]);
    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.table === "contact_segments" && c.name === "update")).toBe(false);
  });

  it("a failed tag write is recorded and the pass continues", async () => {
    const { db, calls } = makeDb([
      { data: [segRow()] },
      {
        data: [
          contactRow({ id: "c1" }),
          // Null columns (pre-backfill rows) read as empty, not as a crash.
          contactRow({
            id: "c2",
            customer_e164: "+15550002222",
            tags: null,
            alias_e164s: null
          })
        ]
      },
      reread(), // c1 re-read
      { error: { message: "locked" } }, // c1 write fails
      reread(null), // c2 re-read (a pre-backfill null column)
      { data: null }, // c2 write
      { data: null } // stamp
    ]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.errors).toEqual(["business biz-a: tag write for contact c1: locked"]);
    expect(result.tagsWritten).toBe(1);
    expect(result.applied).toBe(1);
    // Both contacts got their automation: the hooks run BEFORE the column
    // write, so c1's failure cost it only the column, which the next night
    // retries (and the dedupe key makes that retry a no-op for the flow).
    expect(enqueueContactEventRuns).toHaveBeenCalledTimes(2);
    const writes = calls.filter((c) => c.table === "contacts" && c.name === "update");
    expect(writes[1].args[0]).toMatchObject({ tags: ["Follow up"] });
  });

  it("counts a 25-tag-cap drop and keeps going", async () => {
    const full = Array.from({ length: 25 }, (_, i) => `t${i}`);
    const { db, calls } = makeDb([
      { data: [segRow()] },
      { data: [contactRow({ id: "cFull", tags: full }), contactRow({ id: "c2", customer_e164: "+15550002222" })] },
      reread(), // c2 re-read (cFull never reaches the hooks)
      { data: null }, // c2 write (cFull gets none)
      { data: null } // stamp
    ]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.droppedAtTagCap).toBe(1);
    expect(result.tagsWritten).toBe(1);
    expect(calls.filter((c) => c.table === "contacts" && c.name === "update")).toHaveLength(1);
  });

  it("stops at the per-business write cap, loudly, and still stamps", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rows = Array.from({ length: CONTACT_PAGE }, (_, i) =>
        contactRow({ id: `c${i}`, customer_e164: `+1555100${String(i).padStart(4, "0")}` })
      );
      const { db, calls } = makeDb([
        { data: [segRow()] },
        { data: rows },
        reread(), // write-time re-read
        { data: null }, // the single budgeted write
        { data: null } // stamp
      ]);
      const result = await runSegmentActionSweep(db, NOW, 1);
      expect(result.tagsWritten).toBe(1);
      expect(result.cappedBusinesses).toEqual([BIZ]);
      expect(result.applied).toBe(1);
      expect(calls.filter((c) => c.table === "contacts" && c.name === "update")).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("hit the 1-write cap")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("trims a contact's adds to the remaining budget, writes them, then stops", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { db, calls } = makeDb([
        {
          data: [
            segRow({ id: "s1", action_tag: "One" }),
            segRow({ id: "s2", action_tag: "Two" })
          ]
        },
        { data: [contactRow({ id: "c1" }), contactRow({ id: "c2", customer_e164: "+15550002222" })] },
        reread(), // write-time re-read
        { data: null }, // trimmed write for c1
        { data: null } // stamp
      ]);
      const result = await runSegmentActionSweep(db, NOW, 1);
      expect(result.tagsWritten).toBe(1);
      expect(result.cappedBusinesses).toEqual([BIZ]);
      const write = calls.find((c) => c.table === "contacts" && c.name === "update");
      expect(write?.args[0]).toMatchObject({ tags: ["One"] });
      expect(enqueueContactEventRuns).toHaveBeenCalledTimes(1);
      expect(enqueueContactEventRuns.mock.calls[0][2]).toMatchObject({ tag: "One" });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a failed write on the capped contact still ends the pass as capped", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { db } = makeDb([
        {
          data: [
            segRow({ id: "s1", action_tag: "One" }),
            segRow({ id: "s2", action_tag: "Two" })
          ]
        },
        { data: [contactRow({ id: "c1" })] },
        reread(), // write-time re-read
        { error: { message: "locked" } }, // the trimmed write fails
        { data: null } // stamp
      ]);
      const result = await runSegmentActionSweep(db, NOW, 1);
      expect(result.tagsWritten).toBe(0);
      expect(result.cappedBusinesses).toEqual([BIZ]);
      expect(result.errors).toEqual(["business biz-a: tag write for contact c1: locked"]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("charges the cap to the announcement, so erroring writes cannot storm", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The hooks fire before the column write, so the budget has to be
      // spent there. Charging it to successful writes only would let a
      // business whose writes all error announce every match it has.
      const { db } = makeDb([
        { data: [segRow()] },
        { data: [contactRow({ id: "c1" }), contactRow({ id: "c2", customer_e164: "+15550002222" })] },
        reread(), // c1 re-read
        { error: { message: "locked" } }, // c1's write fails
        { data: null } // stamp
      ]);
      const result = await runSegmentActionSweep(db, NOW, 1);
      expect(result.tagsWritten).toBe(0);
      expect(result.errors).toEqual(["business biz-a: tag write for contact c1: locked"]);
      expect(result.cappedBusinesses).toEqual([BIZ]);
      // c1 spent the whole budget when its automation fired; c2 waits for
      // the next night rather than fanning out past the cap.
      expect(enqueueContactEventRuns).toHaveBeenCalledTimes(1);
      expect(applyGoalEvent).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("pages contacts in explicit chunks until a short page", async () => {
    const page1 = Array.from({ length: CONTACT_PAGE }, (_, i) =>
      contactRow({ id: `p${i}`, customer_e164: `+1555200${String(i).padStart(4, "0")}`, tags: [] })
    );
    const { db, calls } = makeDb([
      { data: [segRow({ filters: { tagsAny: ["VIP"] } })] },
      { data: page1 }, // full page, nothing matches
      { data: [contactRow({ id: "hit", customer_e164: "+15550002222", tags: ["VIP"] })] },
      reread(["VIP"]), // write-time re-read
      { data: null }, // write
      { data: null } // stamp
    ]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.tagsWritten).toBe(1);
    expect(result.contactsScanned).toBe(CONTACT_PAGE + 1);
    const ranges = calls
      .filter((c) => c.table === "contacts" && c.name === "range")
      .map((c) => c.args);
    expect(ranges).toEqual([
      [0, CONTACT_PAGE - 1],
      [CONTACT_PAGE, 2 * CONTACT_PAGE - 1]
    ]);
  });

  it("isolates a business whose sweep throws, and still processes the next one", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { db } = makeDb(
        [
          {
            data: [
              segRow({ id: "s-a", business_id: BIZ }),
              segRow({ id: "s-b", business_id: "biz-b" })
            ]
          },
          // biz-a's contacts read THROWS (consumes no scripted result).
          { data: [] }, // biz-b contacts: none
          { data: null } // biz-b stamp
        ],
        { throwFrom: { table: "contacts", value: new Error("exploded"), times: 1 } }
      );
      const result = await runSegmentActionSweep(db, NOW);
      expect(result.errors).toEqual(["business biz-a: sweep threw: exploded"]);
      expect(result.applied).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("stringifies a non-Error throw", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { db } = makeDb([{ data: [segRow()] }], {
        throwFrom: { table: "contacts", value: "string-boom", times: 1 }
      });
      const result = await runSegmentActionSweep(db, NOW);
      expect(result.errors).toEqual(["business biz-a: sweep threw: string-boom"]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("records a failed last_applied_at stamp (and reads a null contact page as empty)", async () => {
    const { db } = makeDb([
      { data: [segRow()] },
      { data: null }, // no contacts
      { error: { message: "stamp down" } }
    ]);
    const result = await runSegmentActionSweep(db, NOW);
    expect(result.errors).toEqual(["business biz-a: last_applied_at stamp: stamp down"]);
    expect(result.applied).toBe(0);
  });

  it("exports the production cap the route relies on", () => {
    expect(MAX_TAG_WRITES_PER_RUN).toBe(200);
  });
});
