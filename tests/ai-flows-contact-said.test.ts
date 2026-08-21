import { describe, expect, it } from "vitest";
import {
  SAID_CLAIM_MAX_ITEMS,
  SAID_CLAIM_MAX_LINE_CHARS,
  SAID_OFFER_MAX_ITEMS,
  SAID_OFFER_MAX_LINE_CHARS,
  clipSaid,
  formatContactSaid,
  loadContactSaid,
  pickCallerHighlights,
  type SaidEvent
} from "../supabase/functions/_shared/ai_flows/contact_said";

/**
 * What the lead themselves has said, rendered for a teammate. The fixture is
 * Daniel Villanueva's real Aug 7 call: the ask he made ("shoot me an email
 * then we can talk on Monday") is the third of four turns, followed by a
 * two-word pleasantry, which is exactly the shape the highlight rules exist
 * to handle.
 */

const DANIEL_TURNS = [
  "Not really. Nope. I mean",
  "What are we going to talk about?",
  "It's full of shit. Yeah, feel free to shoot me an email then we can talk on Monday.",
  "Thank you."
];

describe("pickCallerHighlights", () => {
  it("keeps the ask and drops the trailing pleasantry", () => {
    const picked = pickCallerHighlights(DANIEL_TURNS, 3);
    expect(picked).toContain(
      "It's full of shit. Yeah, feel free to shoot me an email then we can talk on Monday."
    );
    expect(picked).not.toContain("Thank you.");
  });

  it("keeps the LAST turns, where a lead states what they want", () => {
    const picked = pickCallerHighlights(DANIEL_TURNS, 2);
    expect(picked).toEqual([
      "What are we going to talk about?",
      "It's full of shit. Yeah, feel free to shoot me an email then we can talk on Monday."
    ]);
  });

  it("keeps short answers when the whole call was short, rather than showing nothing", () => {
    // A real call that produced only "Yeah sure" must not render as silence.
    expect(pickCallerHighlights(["Yeah sure", "Ok bye"], 3)).toEqual(["Yeah sure", "Ok bye"]);
  });

  it("ignores blank turns and handles an empty call", () => {
    expect(pickCallerHighlights(["  ", ""], 3)).toEqual([]);
    expect(pickCallerHighlights([], 3)).toEqual([]);
  });
});

describe("clipSaid", () => {
  it("collapses whitespace and marks a cut", () => {
    expect(clipSaid("  a   b  ", 20)).toBe("a b");
    expect(clipSaid("abcdefghij", 5)).toBe("abcd…");
  });

  it("never returns an empty marker for a tiny cap", () => {
    expect(clipSaid("abcdef", 1).length).toBeGreaterThan(0);
  });
});

describe("formatContactSaid", () => {
  const events: SaidEvent[] = [
    { at: "2026-08-07T22:57:30Z", channel: "call", text: "shoot me an email then we can talk on Monday" },
    { at: "2026-08-08T15:00:00Z", channel: "text", text: "Still waiting on those comps" }
  ];

  it("names the lead and quotes only their words, oldest first", () => {
    const block = formatContactSaid(events, {
      leadLabel: "Daniel Villanueva",
      maxItems: SAID_CLAIM_MAX_ITEMS,
      maxLineChars: SAID_CLAIM_MAX_LINE_CHARS
    });
    expect(block).toContain("What Daniel Villanueva has said so far:");
    // Conversation order, ending on the most recent thing they said.
    const lines = (block ?? "").split("\n");
    expect(lines[1]).toContain("shoot me an email");
    expect(lines[2]).toContain("Still waiting on those comps");
    expect(lines[1]).toContain("(call, Aug 7)");
    expect(lines[2]).toContain("(text, Aug 8)");
  });

  it("keeps the NEWEST items when over the cap", () => {
    const many: SaidEvent[] = [
      { at: "2026-08-01T10:00:00Z", channel: "text", text: "oldest" },
      { at: "2026-08-05T10:00:00Z", channel: "text", text: "middle" },
      { at: "2026-08-09T10:00:00Z", channel: "text", text: "newest" }
    ];
    const block = formatContactSaid(many, { maxItems: 2, maxLineChars: 100 });
    expect(block).not.toContain("oldest");
    expect(block).toContain("middle");
    expect(block).toContain("newest");
  });

  it("falls back to a generic subject when the flow captured no name", () => {
    const block = formatContactSaid(events, { maxItems: 2, maxLineChars: 100 });
    expect(block).toContain("What this lead has said so far:");
    expect(formatContactSaid(events, { leadLabel: "  ", maxItems: 2, maxLineChars: 100 })).toContain(
      "this lead"
    );
  });

  it("returns null when the lead has said nothing we hold", () => {
    expect(formatContactSaid([], { maxItems: 2, maxLineChars: 100 })).toBeNull();
    expect(
      formatContactSaid([{ at: "2026-08-07T00:00:00Z", channel: "text", text: "   " }], {
        maxItems: 2,
        maxLineChars: 100
      })
    ).toBeNull();
    // No timestamp means no place in the ordering; drop rather than guess.
    expect(
      formatContactSaid([{ at: "", channel: "text", text: "orphan" }], {
        maxItems: 2,
        maxLineChars: 100
      })
    ).toBeNull();
  });

  it("omits an unparseable date instead of printing Invalid Date", () => {
    const block = formatContactSaid([{ at: "not-a-date", channel: "text", text: "hi" }], {
      maxItems: 2,
      maxLineChars: 100
    });
    expect(block).toContain("(text)");
    expect(block).not.toContain("Invalid");
  });

  it("clips a long line at the configured cap", () => {
    const long = "x".repeat(500);
    const block = formatContactSaid([{ at: "2026-08-07T00:00:00Z", channel: "call", text: long }], {
      maxItems: 1,
      maxLineChars: SAID_OFFER_MAX_LINE_CHARS
    });
    expect(block).toContain("…");
    expect((block ?? "").length).toBeLessThan(long.length);
  });

  it("shows less on an offer than on a claim", () => {
    // An offer only has to inform a yes or no; the claimer has to act.
    expect(SAID_OFFER_MAX_ITEMS).toBeLessThan(SAID_CLAIM_MAX_ITEMS);
    expect(SAID_OFFER_MAX_LINE_CHARS).toBeLessThan(SAID_CLAIM_MAX_LINE_CHARS);
  });

  it("keeps the copy free of em dashes", () => {
    expect(formatContactSaid(events, { maxItems: 2, maxLineChars: 100 })).not.toMatch(/—/);
  });
});

// ---------------------------------------------------------------------------
// loadContactSaid (fake chainable client, one scripted result per await)
// ---------------------------------------------------------------------------

const BIZ = "b1";
const LEAD = "+14802949456";

type Scripted = { data?: unknown; error?: unknown };

function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    // The loaders resolve data_residency_mode before reading content
    // now, so a residency tenant's rows come from their own box.
    // Answered out of band, and not recorded: these fakes are
    // SEQUENTIAL queues, so letting the mode lookup take a scripted
    // result would silently shift every content read after it.
    if (table === "businesses") {
      const mode: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) mode[m] = () => mode;
      mode["maybeSingle"] = () =>
        Promise.resolve({ data: { data_residency_mode: "supabase" }, error: null });
      return mode;
    }
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "is", "in", "or", "gte", "order", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["maybeSingle"] = () => {
      calls.push({ table, name: "maybeSingle", args: [] });
      return Promise.resolve(next());
    };
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return {
    db: { from: (t: string) => (calls.push({ table: t, name: "from", args: [] }), from(t)) },
    calls
  };
}

const PLAIN_CONTACT: Scripted = { data: { customer_e164: LEAD, alias_e164s: [] } };

function inboundJob(text: string, createdAt: string) {
  return { created_at: createdAt, payload: { data: { payload: { text } } } };
}

describe("loadContactSaid", () => {
  it("returns nothing, and touches no table, without a phone", async () => {
    const { db, calls } = makeDb([]);
    expect(await loadContactSaid(db, BIZ, "")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("merges their texts with their own words from a call", async () => {
    const { db } = makeDb([
      PLAIN_CONTACT,
      { data: [inboundJob("Still waiting on those comps", "2026-08-08T15:00:00Z")] },
      { data: [{ id: "call-1", started_at: "2026-08-07T22:57:00Z" }] },
      {
        data: DANIEL_TURNS.map((content, i) => ({ content, turn_index: i }))
      }
    ]);
    const events = await loadContactSaid(db, BIZ, LEAD);
    expect(events).toHaveLength(2);
    const call = events.find((e) => e.channel === "call");
    // The ask survives; the trailing pleasantry does not.
    expect(call?.text).toContain("shoot me an email");
    expect(call?.text).not.toContain("Thank you.");
    expect(events.find((e) => e.channel === "text")?.text).toBe("Still waiting on those comps");
  });

  it("reads the CALLER turns, never our own side", async () => {
    const { db, calls } = makeDb([
      PLAIN_CONTACT,
      { data: [] },
      { data: [{ id: "call-1", started_at: "2026-08-07T22:57:00Z" }] },
      { data: [{ content: "just the caller", turn_index: 0 }] }
    ]);
    await loadContactSaid(db, BIZ, LEAD);
    const turnEqs = calls.filter((c) => c.table === "voice_call_transcript_turns" && c.name === "eq");
    expect(turnEqs.some((c) => c.args[0] === "role" && c.args[1] === "caller")).toBe(true);
  });

  it("excludes soft-deleted messages and calls", async () => {
    const { db, calls } = makeDb([PLAIN_CONTACT, { data: [] }, { data: [] }]);
    await loadContactSaid(db, BIZ, LEAD);
    for (const table of ["sms_inbound_jobs", "voice_call_transcripts"]) {
      expect(
        calls.some((c) => c.table === table && c.name === "is" && c.args[0] === "deleted_at"),
        `${table} must filter deleted_at`
      ).toBe(true);
    }
  });

  it("degrades to the other source when one query errors", async () => {
    const { db } = makeDb([
      PLAIN_CONTACT,
      { error: { message: "boom" } },
      { data: [{ id: "call-1", started_at: "2026-08-07T22:57:00Z" }] },
      { data: [{ content: "we spoke about the roof", turn_index: 0 }] }
    ]);
    const events = await loadContactSaid(db, BIZ, LEAD);
    expect(events).toHaveLength(1);
    expect(events[0].channel).toBe("call");
  });

  it("skips a call whose turns fail to load, keeping the rest", async () => {
    const { db } = makeDb([
      PLAIN_CONTACT,
      { data: [inboundJob("hi", "2026-08-08T15:00:00Z")] },
      { data: [{ id: "call-1", started_at: "2026-08-07T22:57:00Z" }] },
      { error: { message: "turns down" } }
    ]);
    const events = await loadContactSaid(db, BIZ, LEAD);
    expect(events.map((e) => e.channel)).toEqual(["text"]);
  });

  it("omits a call with no caller turns rather than an empty quote", async () => {
    const { db } = makeDb([
      PLAIN_CONTACT,
      { data: [] },
      { data: [{ id: "call-1", started_at: "2026-08-07T22:57:00Z" }] },
      { data: [{ content: "   ", turn_index: 0 }] }
    ]);
    expect(await loadContactSaid(db, BIZ, LEAD)).toEqual([]);
  });

  it("returns an empty list when the calls query itself errors", async () => {
    const { db } = makeDb([PLAIN_CONTACT, { data: [] }, { error: { message: "nope" } }]);
    expect(await loadContactSaid(db, BIZ, LEAD)).toEqual([]);
  });

  it("never throws when the client itself blows up", async () => {
    const exploding = {
      from: () => {
        throw new Error("connection lost");
      }
    };
    expect(await loadContactSaid(exploding, BIZ, LEAD)).toEqual([]);
  });

  it("queries every number a merged contact spans", async () => {
    const { db, calls } = makeDb([
      { data: { customer_e164: "+16025550000", alias_e164s: [LEAD] } },
      { data: [] },
      { data: [] }
    ]);
    await loadContactSaid(db, BIZ, LEAD);
    const inIn = calls.find((c) => c.table === "sms_inbound_jobs" && c.name === "in");
    expect(inIn?.args[1]).toContain(LEAD);
    expect(inIn?.args[1]).toContain("+16025550000");
  });
});

describe("loadContactSaid: null columns from the database", () => {
  it("tolerates null timestamps, null payloads, and null turn content", async () => {
    // PostgREST returns nulls for nullable columns; every fallback in the
    // loader has to hold, because a null here must not throw inside an offer.
    const { db } = makeDb([
      { data: { customer_e164: LEAD, alias_e164s: null } },
      { data: [{ created_at: null, payload: null }, inboundJob("real text", null as never)] },
      { data: [{ id: "call-1", started_at: null }] },
      { data: [{ content: null, turn_index: 0 }, { content: "the roof needs work", turn_index: 1 }] }
    ]);
    const events = await loadContactSaid(db, BIZ, LEAD);
    const call = events.find((e) => e.channel === "call");
    expect(call?.text).toBe("the roof needs work");
    // A null timestamp yields an empty `at`, which the formatter then drops
    // rather than placing it arbitrarily in the ordering.
    expect(call?.at).toBe("");
    expect(formatContactSaid(events, { maxItems: 4, maxLineChars: 100 })).toBeNull();
  });

  it("handles a null data array from either query", async () => {
    const { db } = makeDb([PLAIN_CONTACT, { data: null }, { data: null }]);
    expect(await loadContactSaid(db, BIZ, LEAD)).toEqual([]);
  });

  it("handles null turn data for a real call", async () => {
    const { db } = makeDb([
      PLAIN_CONTACT,
      { data: [] },
      { data: [{ id: "call-1", started_at: "2026-08-07T22:57:00Z" }] },
      { data: null }
    ]);
    expect(await loadContactSaid(db, BIZ, LEAD)).toEqual([]);
  });
});
