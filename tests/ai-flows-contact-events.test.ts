import { beforeEach, describe, expect, it, vi } from "vitest";

// The Meta CAPI hook runs first on every added-tag event and makes its own
// DB reads; mocking it keeps these scripted result sequences unshifted (the
// hook has its own suite: tests/meta-capi-stage-hook.test.ts).
const recordStageChangeForMeta = vi.fn(async () => false);
vi.mock("../supabase/functions/_shared/ai_flows/meta_capi.ts", () => ({
  recordStageChangeForMeta: (...a: unknown[]) =>
    recordStageChangeForMeta(...(a as []))
}));

import {
  contactEventText,
  contactEventTriggerMatches,
  contactEventTriggerScope,
  enqueueContactEventRuns,
  hydrateContactEventContact,
  type ContactEventContact,
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
  contact: {
    e164: "+16025550111",
    name: "Joe",
    email: "joe@x.com",
    tags: ["VIP", "Engaged"],
    source: "ReferralExchange"
  },
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
    expect(text).toContain("source: ReferralExchange");
    expect(text).toContain("tag: Engaged");
    expect(text).toContain("change: added");
  });

  it("never prints an email KEY under the phone label", () => {
    // `e164` is the contact key, not always a phone. The cadence's
    // extract_text lifts lead_phone out of this exact text, so printing
    // "phone: email:val@example.com" tells Gemini that IS the person's number.
    // A contact with no phone gets no phone line at all.
    const text = contactEventText(
      input({
        contact: {
          e164: "email:valm0417@gmail.com",
          name: "Valerie Marino",
          email: "valm0417@gmail.com",
          tags: ["Needs Follow Up"]
        }
      })
    );
    expect(text).not.toContain("phone:");
    expect(text).not.toContain("email:valm0417@gmail.com");
    expect(text).toContain("email: valm0417@gmail.com");
    expect(text).toContain("name: Valerie Marino");
  });

  it("carries the lead SOURCE, so a flow never has to guess the network", () => {
    // Amy Laidlaw's "Needs Follow Up (AI cadence)" reads this text to fill
    // {{vars.lead_site}}. Across its first 42 runs, 23 fell back to the
    // flow's "it does not say" answer while contacts.lead_source held
    // "ReferralExchange"; the 17 that got it right only did so because a
    // matching TAG happened to leak through the tags line. The column is the
    // answer, so the text states it.
    const text = contactEventText(input({ contact: { e164: "+16025550111", source: " Clever " } }));
    expect(text).toContain("source: Clever");
  });

  it("omits the source line entirely when the contact has no lead source", () => {
    // An absent line reads as "unknown" to the extraction, which is true. A
    // "source: " line with nothing after it reads as a value that is blank,
    // which invites a model to answer with the empty string.
    const text = contactEventText(input({ contact: { e164: "+16025550111", name: "Joe" } }));
    expect(text).not.toContain("source:");
    expect(text).toContain("name: Joe");
  });

  it("exposes the source to templates as {{trigger.contact_source}}", () => {
    expect(contactEventTriggerScope(input()).contact_source).toBe("ReferralExchange");
    // Empty, never undefined: a template renders the gap as nothing.
    expect(
      contactEventTriggerScope(input({ contact: { e164: "+16025550111" } })).contact_source
    ).toBe("");
  });

  it("normalizes the source IDENTICALLY in the text and in the template scope", () => {
    // These two are documented as the same value. A stored "  Clever  "
    // reaching a template padded while the extraction reads it trimmed would
    // make a template that compares them disagree with itself.
    const padded = input({ contact: { e164: "+16025550111", source: "  Clever  " } });
    expect(contactEventTriggerScope(padded).contact_source).toBe("Clever");
    expect(contactEventText(padded)).toContain("source: Clever");
    // Whitespace-only is no source at all, on both sides.
    const blank = input({ contact: { e164: "+16025550111", source: "   " } });
    expect(contactEventTriggerScope(blank).contact_source).toBe("");
    expect(contactEventText(blank)).not.toContain("source:");
  });

  it("keeps the contact KEY as `from`, which consumers look the contact up by", () => {
    // Not the bare address: the worker seeds {{vars.contact_language}} from
    // this value with a customer_e164 lookup, so it has to be the identity.
    // from_matches lines up from the other side, where
    // resolveRefIdentityValues lists the key alongside the address.
    const scope = contactEventTriggerScope(
      input({ contact: { e164: "email:valm0417@gmail.com", email: "valm0417@gmail.com" } })
    );
    expect(scope.from).toBe("email:valm0417@gmail.com");
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
    for (const m of ["select", "insert", "eq", "is", "or", "not", "order", "range", "limit"]) {
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
  beforeEach(() => {
    recordStageChangeForMeta.mockClear();
  });

  it("hands ADDED tag events to the Meta CAPI hook (and only those)", async () => {
    const { db } = makeDb([{ data: [], error: null }]);
    await enqueueContactEventRuns(db, BIZ, input());
    expect(recordStageChangeForMeta).toHaveBeenCalledWith(db, BIZ, {
      contactE164: "+16025550111",
      tag: "Engaged",
      dedupeKey: "ce:test:1"
    });

    recordStageChangeForMeta.mockClear();
    // change omitted defaults to "added", still hooked.
    await enqueueContactEventRuns(makeDb([{ data: [], error: null }]).db, BIZ, input({ change: undefined }));
    expect(recordStageChangeForMeta).toHaveBeenCalledTimes(1);

    recordStageChangeForMeta.mockClear();
    // A tagless tag_changed event hands the hook an empty tag (it skips it).
    await enqueueContactEventRuns(
      makeDb([{ data: [], error: null }]).db,
      BIZ,
      input({ tag: undefined })
    );
    expect(recordStageChangeForMeta).toHaveBeenCalledWith(
      expect.anything(),
      BIZ,
      expect.objectContaining({ tag: "" })
    );

    recordStageChangeForMeta.mockClear();
    await enqueueContactEventRuns(
      makeDb([{ data: [], error: null }]).db,
      BIZ,
      input({ change: "removed" })
    );
    await enqueueContactEventRuns(
      makeDb([{ data: [], error: null }]).db,
      BIZ,
      input({ kind: "contact_created", tag: undefined, change: undefined })
    );
    expect(recordStageChangeForMeta).not.toHaveBeenCalled();
  });

  it("enrolls an EMAIL-KEYED contact, with no phantom phone in what the flow reads", async () => {
    // The whole chain in one assertion: an email-only lead becomes a contact
    // (PR #1486), gets tagged, and the tag_changed flow it starts sees an
    // honest window. This is the path that reaches the cadence's email arm,
    // and until now that window claimed their phone number was
    // "email:valm0417@gmail.com".
    const { db, calls } = makeDb([
      {
        data: [
          flowRow("cadence", {
            channel: "tag_changed",
            tag: "Needs Follow Up",
            conditions: []
          })
        ],
        error: null
      },
      { data: null, error: null } // run insert
    ]);
    const enrolled = await enqueueContactEventRuns(
      db,
      BIZ,
      input({
        tag: "Needs Follow Up",
        contact: {
          e164: "email:valm0417@gmail.com",
          name: "Valerie Marino",
          email: "valm0417@gmail.com",
          tags: ["Needs Follow Up"]
        }
      })
    );
    expect(enrolled).toBe(1);

    const insert = calls.find((c) => c.name === "insert")!.args[0] as Record<string, unknown>;
    const ctx = insert.context as { trigger: Record<string, unknown> };
    expect(ctx.trigger.from).toBe("email:valm0417@gmail.com");
    const windowText = ctx.trigger.windowText as string;
    expect(windowText).not.toContain("phone:");
    expect(windowText).toContain("email: valm0417@gmail.com");
    expect(windowText).toContain("tag: Needs Follow Up");
  });

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

// ── hydrateContactEventContact ──────────────────────────────────────────────

/**
 * Write sites mostly know the phone and nothing else, but flows are written
 * against the documented `name: / phone: / email: / tags: …` text. The gap
 * was not theoretical: Amy Laidlaw's "Clever - Spoke Check" flow triggers on
 * owner_assigned with a `contains "clever"` condition that reads the tags
 * line, and the route_to_team claim that assigns the owner passes only
 * `{ e164 }`. The flow was enabled for weeks and had zero runs.
 */
describe("hydrateContactEventContact", () => {
  const PHONE = "+16025550111";

  it("fills in the fields the caller left out, and never overwrites one it supplied", async () => {
    const { db, calls } = makeDb([
      {
        data: {
          display_name: "Joe Seller",
          email: "joe@x.com",
          tags: ["Clever", "  ", "VIP", 7]
        },
        error: null
      }
    ]);
    const out = await hydrateContactEventContact(db, BIZ, { e164: PHONE });
    // Blank and non-string stored tags are dropped, like every other reader.
    expect(out).toEqual({
      e164: PHONE,
      name: "Joe Seller",
      email: "joe@x.com",
      tags: ["Clever", "VIP"]
    });
    // Scoped to the tenant, and matched on the primary number OR an alias.
    expect(calls.find((c) => c.name === "eq")!.args).toEqual(["business_id", BIZ]);
    expect(calls.find((c) => c.name === "or")!.args[0]).toBe(
      `customer_e164.eq.${PHONE},alias_e164s.cs.{${PHONE}}`
    );

    // The caller's own values win: a tag_changed site passes the POST-write
    // tag list, which is fresher than the row.
    const supplied = makeDb([
      { data: { display_name: "Stale", email: "stale@x.com", tags: ["Old"] }, error: null }
    ]);
    expect(
      await hydrateContactEventContact(supplied.db, BIZ, {
        e164: PHONE,
        name: "Fresh",
        tags: ["New"]
      })
    ).toEqual({ e164: PHONE, name: "Fresh", email: "stale@x.com", tags: ["New"] });
  });

  it("an explicitly EMPTY value is the caller's answer, not a gap to fill", async () => {
    // A tag_changed site passes the post-write list, which is `[]` once the
    // last tag is removed. Reading over that would put the tags back on the
    // very event that cleared them.
    const cleared = makeDb([{ data: { tags: ["Clever", "VIP"] }, error: null }]);
    const out = await hydrateContactEventContact(cleared.db, BIZ, {
      e164: PHONE,
      name: "Joe",
      email: "joe@x.com",
      tags: [],
      source: "Clever"
    });
    expect(out.tags).toEqual([]);
    expect(cleared.calls).toHaveLength(0);

    // Same rule for the strings: supplied-but-blank is still supplied.
    const blank = makeDb([{ data: { display_name: "Row Name", email: "row@x.com" }, error: null }]);
    expect(
      await hydrateContactEventContact(blank.db, BIZ, {
        e164: PHONE,
        name: "",
        email: "",
        tags: [],
        source: ""
      })
    ).toEqual({ e164: PHONE, name: "", email: "", tags: [], source: "" });
    expect(blank.calls).toHaveLength(0);

    // An empty list still leaves name/email open to hydration.
    const partial = makeDb([{ data: { display_name: "Row Name" }, error: null }]);
    expect(await hydrateContactEventContact(partial.db, BIZ, { e164: PHONE, tags: [] })).toEqual({
      e164: PHONE,
      name: "Row Name",
      tags: []
    });
  });

  it("reads nothing when the caller already carries every hydrated field", async () => {
    const { db, calls } = makeDb([]);
    const full: ContactEventContact = {
      e164: PHONE,
      name: "Joe",
      email: "joe@x.com",
      tags: ["VIP"],
      source: "Clever"
    };
    expect(await hydrateContactEventContact(db, BIZ, full)).toBe(full);
    expect(calls).toHaveLength(0);
  });

  it("hydrates an email-keyed contact with an exact match, not the alias filter", async () => {
    // Without this, a contact_created event for an email-only lead carried no
    // tags line, so a flow triggering on `tags contains ...` never fired for
    // exactly the leads the email key was added to reach.
    const KEY = "email:valm0417@gmail.com";
    const { db, calls } = makeDb([
      { data: { display_name: "Valerie", email: "valm0417@gmail.com", tags: ["RefEx"] }, error: null }
    ]);
    expect(await hydrateContactEventContact(db, BIZ, { e164: KEY })).toEqual({
      e164: KEY,
      name: "Valerie",
      email: "valm0417@gmail.com",
      tags: ["RefEx"]
    });
    expect(calls.some((c) => c.name === "or")).toBe(false);
    expect(calls.filter((c) => c.name === "eq").map((c) => c.args)).toContainEqual([
      "customer_e164",
      KEY
    ]);
  });

  it("hydrates the lead source from the row, and lets the caller override it", async () => {
    const { db, calls } = makeDb([
      {
        data: {
          display_name: "Sandy Baldwin",
          email: "sandy@x.com",
          tags: ["Needs Follow Up"],
          lead_source: "  ReferralExchange  "
        },
        error: null
      }
    ]);
    expect(await hydrateContactEventContact(db, BIZ, { e164: PHONE })).toEqual({
      e164: PHONE,
      name: "Sandy Baldwin",
      email: "sandy@x.com",
      tags: ["Needs Follow Up"],
      source: "ReferralExchange"
    });
    // The column is in the projection: without it the read returns undefined
    // and the source silently never hydrates.
    expect(calls.find((c) => c.name === "select")!.args[0]).toContain("lead_source");

    // A caller who knows the source keeps it, same rule as name/email/tags.
    const supplied = makeDb([{ data: { lead_source: "Stale" }, error: null }]);
    expect(
      await hydrateContactEventContact(supplied.db, BIZ, {
        e164: PHONE,
        name: "Joe",
        email: "joe@x.com",
        tags: [],
        source: "HomeLight"
      })
    ).toEqual({ e164: PHONE, name: "Joe", email: "joe@x.com", tags: [], source: "HomeLight" });
  });

  it("adds no source key when the row's lead_source is null or blank", async () => {
    // The absent-vs-empty distinction the text relies on: no key here means
    // contactEventText prints no source line at all.
    for (const lead_source of [null, "   "]) {
      const { db } = makeDb([{ data: { display_name: "Joe", lead_source }, error: null }]);
      const out = await hydrateContactEventContact(db, BIZ, { e164: PHONE });
      expect(out.source).toBeUndefined();
      expect(out.name).toBe("Joe");
    }
  });

  it("reads the row when the source is the ONLY field the caller left out", async () => {
    const { db, calls } = makeDb([{ data: { lead_source: "Clever" }, error: null }]);
    expect(
      await hydrateContactEventContact(db, BIZ, {
        e164: PHONE,
        name: "Joe",
        email: "joe@x.com",
        tags: ["VIP"]
      })
    ).toEqual({ e164: PHONE, name: "Joe", email: "joe@x.com", tags: ["VIP"], source: "Clever" });
    expect(calls.some((c) => c.name === "select")).toBe(true);
  });

  it("skips the read for a malformed email key", async () => {
    const { db, calls } = makeDb([]);
    const e164 = "email:garbage";
    expect(await hydrateContactEventContact(db, BIZ, { e164 })).toEqual({ e164 });
    expect(calls).toHaveLength(0);
  });

  it("skips the read for a phone that cannot be interpolated into the filter", async () => {
    // A stray comma or paren would change what the `or` filter means, so
    // anything that is not clean E.164 keeps the pre-hydration behavior.
    for (const e164 of ["", "not-a-phone", "+1416555010,junk", "  "]) {
      const { db, calls } = makeDb([]);
      expect(await hydrateContactEventContact(db, BIZ, { e164 })).toEqual({ e164 });
      expect(calls).toHaveLength(0);
    }
    const missing = makeDb([]);
    const noPhone = { e164: undefined } as unknown as ContactEventContact;
    expect(await hydrateContactEventContact(missing.db, BIZ, noPhone)).toBe(noPhone);
    expect(missing.calls).toHaveLength(0);

    // Surrounding whitespace is tolerated (the read still happens).
    const padded = makeDb([{ data: { display_name: "Joe" }, error: null }]);
    expect(await hydrateContactEventContact(padded.db, BIZ, { e164: ` ${PHONE} ` })).toEqual({
      e164: ` ${PHONE} `,
      name: "Joe"
    });
  });

  it("a read failure, a missing row, or empty columns leave the contact untouched", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const failed = makeDb([{ data: null, error: { message: "contacts down" } }]);
    expect(await hydrateContactEventContact(failed.db, BIZ, { e164: PHONE })).toEqual({
      e164: PHONE
    });
    expect(err).toHaveBeenCalled();

    const absent = makeDb([{ data: null, error: null }]);
    expect(await hydrateContactEventContact(absent.db, BIZ, { e164: PHONE })).toEqual({
      e164: PHONE
    });

    // Row exists but every field is null/blank/not a list: nothing to add.
    const bare = makeDb([
      { data: { display_name: null, email: null, tags: null }, error: null }
    ]);
    expect(await hydrateContactEventContact(bare.db, BIZ, { e164: PHONE })).toEqual({
      e164: PHONE
    });
    const blankTags = makeDb([{ data: { tags: ["", "   "] }, error: null }]);
    expect(await hydrateContactEventContact(blankTags.db, BIZ, { e164: PHONE })).toEqual({
      e164: PHONE
    });

    // Never throws: the write that observed the event already happened.
    const thrown = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await hydrateContactEventContact(thrown, BIZ, { e164: PHONE })).toEqual({
      e164: PHONE
    });
    err.mockRestore();
  });
});

describe("enqueueContactEventRuns hydration", () => {
  const PHONE = "+16025550111";

  it("an owner_assigned event carrying only a phone still matches a tag condition", async () => {
    // The exact Clever regression: the claim path knows the lead's number
    // and nothing else, and the flow keys on the tags line.
    const { db, calls } = makeDb([
      {
        data: [
          flowRow("f-clever", {
            channel: "owner_assigned",
            conditions: [{ type: "contains", value: "clever", caseInsensitive: true }]
          })
        ],
        error: null
      },
      { data: { display_name: "Joe Seller", email: "joe@x.com", tags: ["Clever"] }, error: null },
      { data: null, error: null } // run insert
    ]);
    expect(
      await enqueueContactEventRuns(db, BIZ, {
        kind: "owner_assigned",
        contact: { e164: PHONE },
        ownerName: "Dave Lane",
        dedupeKey: "ce:owner:run-1"
      })
    ).toBe(1);

    const insert = calls.find((c) => c.name === "insert")!.args[0] as Record<string, unknown>;
    const trigger = (insert.context as { trigger: Record<string, unknown> }).trigger;
    // The full documented shape, so the flow's extract_text can read the
    // name line and templates can render {{trigger.contact_name}}.
    expect(trigger.windowText).toBe(
      [
        "event: owner_assigned",
        "name: Joe Seller",
        `phone: ${PHONE}`,
        "email: joe@x.com",
        "tags: Clever",
        "owner: Dave Lane"
      ].join("\n")
    );
    expect(trigger.contact_name).toBe("Joe Seller");
    expect(trigger.contact_email).toBe("joe@x.com");
  });

  it("spends no read when nothing is watching this event", async () => {
    // Hydration is gated behind a matching flow, so the common case (a
    // tenant with no flow on this channel) costs exactly the flow listing.
    const { db, calls } = makeDb([
      { data: [flowRow("f-sms", { channel: "sms", conditions: [] })], error: null }
    ]);
    expect(
      await enqueueContactEventRuns(db, BIZ, {
        kind: "owner_assigned",
        contact: { e164: PHONE },
        dedupeKey: "ce:owner:run-2"
      })
    ).toBe(0);
    expect(calls.filter((c) => c.table === "contacts")).toHaveLength(0);
  });
});
