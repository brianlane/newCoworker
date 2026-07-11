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
    for (const m of ["select", "insert", "eq", "or", "limit"]) {
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
