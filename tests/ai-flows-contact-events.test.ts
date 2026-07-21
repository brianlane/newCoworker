import { describe, expect, it, vi } from "vitest";
import {
  contactEventText,
  contactEventTriggerMatches,
  contactEventTriggerScope,
  enqueueContactEventRuns,
  type ContactEventInput
} from "../supabase/functions/_shared/ai_flows/contact_events";

/**
 * Contact-event triggers: contact_created / tag_changed / owner_assigned.
 * Push-evaluated at the write sites; loop-guarded so a flow can't retrigger
 * itself through its own tag writes; best-effort throughout.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";

const input = (over: Partial<ContactEventInput> = {}): ContactEventInput => ({
  kind: "tag_changed",
  contact: { e164: "+16025550111", name: "Joe", email: "joe@x.com", tags: ["VIP", "Engaged"] },
  tag: "Engaged",
  change: "added",
  dedupeKey: "ce:test:1",
  ...over
});

describe("contactEventText / contactEventTriggerScope", () => {
  it("renders the contact as key: value lines with the event fields", () => {
    const text = contactEventText(input());
    expect(text).toContain("event: tag_changed");
    expect(text).toContain("name: Joe");
    expect(text).toContain("phone: +16025550111");
    expect(text).toContain("email: joe@x.com");
    expect(text).toContain("tags: VIP, Engaged");
    expect(text).toContain("tag: Engaged");
    expect(text).toContain("change: added");
  });

  it("omits absent fields and includes the owner line for owner_assigned", () => {
    const text = contactEventText(
      input({ kind: "owner_assigned", contact: { e164: "+16025550111" }, ownerName: "Dania" })
    );
    expect(text).not.toContain("name:");
    expect(text).not.toContain("tags:");
    expect(text).toContain("owner: Dania");
  });

  it("scope carries the channel, windowText, and per-kind extras", () => {
    const scope = contactEventTriggerScope(input());
    expect(scope.channel).toBe("tag_changed");
    expect(scope.from).toBe("+16025550111");
    expect(scope.tag).toBe("Engaged");
    expect(scope.change).toBe("added");
    const created = contactEventTriggerScope(
      input({ kind: "contact_created", tag: undefined, change: undefined })
    );
    expect(created.channel).toBe("contact_created");
    expect(created).not.toHaveProperty("tag");
    const owner = contactEventTriggerScope(
      input({ kind: "owner_assigned", ownerName: "Dania" })
    );
    expect(owner.owner_name).toBe("Dania");
  });

  it("tag_changed defaults change to added in text and scope", () => {
    const noChange = input({ change: undefined });
    expect(contactEventText(noChange)).toContain("change: added");
    expect(contactEventTriggerScope(noChange).change).toBe("added");
  });

  it("a note rides into the text and the trigger scope (needs-human handoff context)", () => {
    // escalateToHuman passes the customer's last message so the team-offer
    // SMS can show WHAT the person needs, not just who they are.
    const noted = input({ note: 'They said: "I would like to speak to a representative"' });
    expect(contactEventText(noted)).toContain(
      'note: They said: "I would like to speak to a representative"'
    );
    expect(contactEventTriggerScope(noted).note).toBe(
      'They said: "I would like to speak to a representative"'
    );
  });

  it("no note → no note line and an empty scope value", () => {
    expect(contactEventText(input())).not.toContain("note:");
    expect(contactEventTriggerScope(input()).note).toBe("");
  });

  it("defaults absent optional fields to empty strings in the scope", () => {
    const sparse = contactEventTriggerScope(
      input({ tag: undefined, change: undefined, contact: { e164: "+16025550111" } })
    );
    expect(sparse.contact_name).toBe("");
    expect(sparse.contact_email).toBe("");
    expect(sparse.tag).toBe("");
    const ownerless = contactEventTriggerScope(
      input({ kind: "owner_assigned", ownerName: undefined })
    );
    expect(ownerless.owner_name).toBe("");
  });
});

describe("contactEventTriggerMatches", () => {
  it("matches on channel for the non-tag kinds", () => {
    expect(
      contactEventTriggerMatches({ channel: "contact_created" }, input({ kind: "contact_created" }))
    ).toBe(true);
    expect(
      contactEventTriggerMatches({ channel: "owner_assigned" }, input({ kind: "contact_created" }))
    ).toBe(false);
  });

  it("tag_changed narrows by change direction (default added) and tag (case-insensitive)", () => {
    const trig = { channel: "tag_changed", tag: "engaged" };
    expect(contactEventTriggerMatches(trig, input())).toBe(true);
    expect(contactEventTriggerMatches(trig, input({ tag: "Won" }))).toBe(false);
    expect(contactEventTriggerMatches(trig, input({ change: "removed" }))).toBe(false);
    expect(
      contactEventTriggerMatches({ channel: "tag_changed", change: "removed" }, input({ change: "removed" }))
    ).toBe(true);
    // No tag on the trigger = any tag.
    expect(contactEventTriggerMatches({ channel: "tag_changed" }, input({ tag: "Won" }))).toBe(true);
    // Non-string stored tag is treated as "any".
    expect(
      contactEventTriggerMatches({ channel: "tag_changed", tag: 7 }, input({ tag: "Won" }))
    ).toBe(true);
    // An event with change/tag omitted defaults to an "added" event of no tag.
    expect(
      contactEventTriggerMatches({ channel: "tag_changed" }, input({ change: undefined }))
    ).toBe(true);
    expect(
      contactEventTriggerMatches(
        { channel: "tag_changed", tag: "Won" },
        input({ tag: undefined })
      )
    ).toBe(false);
  });
});

// ── enqueueContactEventRuns ─────────────────────────────────────────────────

type Scripted = { data?: unknown; error?: unknown };

function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "insert", "eq", "or", "not", "order", "range", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["maybeSingle"] = async () => {
      calls.push({ table, name: "maybeSingle", args: [] });
      return next();
    };
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

const flowRow = (id: string, trigger: Record<string, unknown>, extra?: Record<string, unknown>[]) => ({
  id,
  definition: { version: 1, trigger, steps: [], ...(extra ? { triggers: extra } : {}) }
});

describe("enqueueContactEventRuns", () => {
  it("enqueues a run for a matching flow with the event scope + dedupe key", async () => {
    const { db, calls } = makeDb([
      { data: [flowRow("f1", { channel: "tag_changed", tag: "Engaged", conditions: [] })], error: null },
      { data: null, error: null } // run insert
    ]);
    expect(await enqueueContactEventRuns(db, BIZ, input())).toBe(1);
    const insert = calls.find((c) => c.name === "insert")!.args[0] as Record<string, unknown>;
    expect(insert.flow_id).toBe("f1");
    expect(insert.dedupe_key).toBe("ce:test:1");
    const ctx = insert.context as { trigger: Record<string, unknown> };
    expect(ctx.trigger.channel).toBe("tag_changed");
    expect(ctx.trigger.from).toBe("+16025550111");
  });

  it("evaluates trigger conditions over the contact text (no match → no run)", async () => {
    const { db, calls } = makeDb([
      {
        data: [
          flowRow("f1", {
            channel: "tag_changed",
            conditions: [{ type: "contains", value: "no-such-text" }]
          })
        ],
        error: null
      }
    ]);
    expect(await enqueueContactEventRuns(db, BIZ, input())).toBe(0);
    expect(calls.some((c) => c.name === "insert")).toBe(false);

    const matching = makeDb([
      {
        data: [
          flowRow("f1", { channel: "tag_changed", conditions: [{ type: "contains", value: "joe@x.com" }] })
        ],
        error: null
      },
      { data: null, error: null }
    ]);
    expect(await enqueueContactEventRuns(matching.db, BIZ, input())).toBe(1);
  });

  it("loop guard: the source flow never retriggers itself; extra triggers still count", async () => {
    const { db, calls } = makeDb([
      {
        data: [
          flowRow("f-src", { channel: "tag_changed", conditions: [] }),
          // f2's PRIMARY trigger is sms; its extras carry the matching one.
          flowRow("f2", { channel: "sms", conditions: [] }, [
            { channel: "tag_changed", conditions: [] }
          ])
        ],
        error: null
      },
      { data: null, error: null } // f2 insert
    ]);
    expect(await enqueueContactEventRuns(db, BIZ, input({ sourceFlowId: "f-src" }))).toBe(1);
    const insert = calls.find((c) => c.name === "insert")!.args[0] as Record<string, unknown>;
    expect(insert.flow_id).toBe("f2");
  });

  it("counts a 23505 dedupe collision as already-enqueued (not an error, not counted)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb([
      { data: [flowRow("f1", { channel: "tag_changed", conditions: [] })], error: null },
      { data: null, error: { code: "23505", message: "dup" } }
    ]);
    expect(await enqueueContactEventRuns(db, BIZ, input())).toBe(0);
    expect(err).not.toHaveBeenCalled();

    const hardFail = makeDb([
      { data: [flowRow("f1", { channel: "tag_changed", conditions: [] })], error: null },
      { data: null, error: { message: "insert down" } }
    ]);
    expect(await enqueueContactEventRuns(hardFail.db, BIZ, input())).toBe(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("flow lookup errors / empty pages / malformed definitions → 0, never throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const lookupErr = makeDb([{ data: null, error: { message: "down" } }]);
    expect(await enqueueContactEventRuns(lookupErr.db, BIZ, input())).toBe(0);

    const nullPage = makeDb([{ data: null, error: null }]);
    expect(await enqueueContactEventRuns(nullPage.db, BIZ, input())).toBe(0);

    const malformed = makeDb([
      { data: [{ id: "f1", definition: null }, { id: "f2" }], error: null }
    ]);
    expect(await enqueueContactEventRuns(malformed.db, BIZ, input())).toBe(0);

    const thrown = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await enqueueContactEventRuns(thrown, BIZ, input())).toBe(0);
    err.mockRestore();
  });

  it("applies the flow's drip stagger to contact-event enrollments", async () => {
    const lastIso = new Date(Date.now() + 10 * 60_000).toISOString();
    const dripFlow = {
      id: "f-drip",
      definition: {
        version: 1,
        trigger: { channel: "tag_changed", conditions: [] },
        steps: [],
        drip: { intervalMinutes: 5 }
      }
    };
    const { db, calls } = makeDb([
      { data: [dripFlow], error: null },
      { data: { earliest_claim_at: lastIso }, error: null }, // latest scheduled slot
      { data: null, error: null } // insert
    ]);
    expect(await enqueueContactEventRuns(db, BIZ, input())).toBe(1);
    const insert = calls.find((c) => c.name === "insert")!.args[0] as Record<string, unknown>;
    expect(Date.parse(insert.earliest_claim_at as string)).toBe(
      Date.parse(lastIso) + 5 * 60_000
    );

    // No scheduled predecessor → the first dripped run starts now.
    const first = makeDb([
      { data: [dripFlow], error: null },
      { data: null, error: null }, // no last slot
      { data: null, error: null }
    ]);
    const before = Date.now();
    expect(await enqueueContactEventRuns(first.db, BIZ, input())).toBe(1);
    const firstInsert = first.calls.find((c) => c.name === "insert")!.args[0] as Record<
      string,
      unknown
    >;
    expect(Date.parse(firstInsert.earliest_claim_at as string)).toBeGreaterThanOrEqual(before);

    // A drip read failure enqueues immediately (best-effort pacing).
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = makeDb([{ data: [dripFlow], error: null }]);
    // Make the drip lookup throw by removing maybeSingle mid-flight: simplest
    // is a db whose second from() blows up.
    let fromCount = 0;
    const throwingDb = {
      from: (table: string) => {
        fromCount += 1;
        if (fromCount === 2) throw new Error("drip read down");
        return (broken.db as { from: (t: string) => unknown }).from(table);
      }
    };
    expect(await enqueueContactEventRuns(throwingDb, BIZ, input())).toBe(1);
    const brokenInsert = broken.calls.find((c) => c.name === "insert")!.args[0] as Record<
      string,
      unknown
    >;
    expect(brokenInsert).not.toHaveProperty("earliest_claim_at");
    err.mockRestore();
  });

  it("re-entry gate: allowReentry=false skips a contact who already ran the flow", async () => {
    const gatedFlow = {
      id: "f-once",
      definition: {
        version: 1,
        trigger: { channel: "tag_changed", conditions: [] },
        steps: [],
        options: { allowReentry: false }
      }
    };
    // Prior (non-test) run exists → no insert. (The gate first expands the
    // contact's identities through the contacts table, then scans runs.)
    const blocked = makeDb([
      { data: [gatedFlow], error: null },
      { data: [], error: null }, // contact identity expansion
      { data: [{ id: "r0", context: { trigger: { from: "+16025550111" } } }], error: null }
    ]);
    expect(await enqueueContactEventRuns(blocked.db, BIZ, input())).toBe(0);
    expect(blocked.calls.some((c) => c.name === "insert")).toBe(false);

    // No prior run → enrolls normally.
    const first = makeDb([
      { data: [gatedFlow], error: null },
      { data: [], error: null }, // contact identity expansion
      { data: [], error: null }, // prior-run lookup
      { data: null, error: null } // insert
    ]);
    expect(await enqueueContactEventRuns(first.db, BIZ, input())).toBe(1);

    // A residual prior TEST run doesn't count.
    const tested = makeDb([
      { data: [gatedFlow], error: null },
      { data: [], error: null }, // contact identity expansion
      {
        data: [{ id: "r0", context: { trigger: { from: "+16025550111", test_mode: true } } }],
        error: null
      },
      { data: null, error: null } // insert
    ]);
    expect(await enqueueContactEventRuns(tested.db, BIZ, input())).toBe(1);
  });

  it("pages through the flow listing so flows past one page still fire", async () => {
    // Page 1 is exactly full (forces a second fetch); the matching flow sits
    // on page 2.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      flowRow(`f${i}`, { channel: "sms", conditions: [] })
    );
    const page2 = [flowRow("f-match", { channel: "tag_changed", conditions: [] })];
    const { db, calls } = makeDb([
      { data: page1, error: null },
      { data: page2, error: null },
      { data: null, error: null } // f-match insert
    ]);
    expect(await enqueueContactEventRuns(db, BIZ, input())).toBe(1);
    const ranges = calls.filter((c) => c.name === "range");
    expect(ranges.map((c) => c.args)).toEqual([
      [0, 99],
      [100, 199]
    ]);
  });

  it("keeps flows already listed when a LATER page fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const page1 = [
      flowRow("f-match", { channel: "tag_changed", conditions: [] }),
      ...Array.from({ length: 99 }, (_, i) => flowRow(`f${i}`, { channel: "sms", conditions: [] }))
    ];
    const { db } = makeDb([
      { data: page1, error: null },
      { data: null, error: { message: "later page down" } },
      { data: null, error: null } // f-match insert
    ]);
    expect(await enqueueContactEventRuns(db, BIZ, input())).toBe(1);
    err.mockRestore();
  });

  it("non-array stored conditions are treated as empty (match everything)", async () => {
    const { db } = makeDb([
      { data: [flowRow("f1", { channel: "owner_assigned", conditions: "junk" })], error: null },
      { data: null, error: null }
    ]);
    expect(
      await enqueueContactEventRuns(db, BIZ, input({ kind: "owner_assigned", ownerName: "D" }))
    ).toBe(1);
  });

  it("a from_matches ref that fails to resolve fails CLOSED for that trigger only", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // Ref resolution queries ai_flow_team_members/contacts via maybeSingle;
    // scripting an error for that read makes resolveFromMatchesRefValues throw.
    const { db } = makeDb([
      {
        data: [
          flowRow("f1", {
            channel: "tag_changed",
            conditions: [
              {
                type: "from_matches",
                ref: { source: "employee", id: "00000000-0000-0000-0000-0000000000ee" }
              }
            ]
          })
        ],
        error: null
      },
      // The ref lookup's maybeSingle result: an error → resolution throws.
      { data: null, error: { message: "roster down" } }
    ]);
    expect(await enqueueContactEventRuns(db, BIZ, input())).toBe(0);
    err.mockRestore();
  });
});
