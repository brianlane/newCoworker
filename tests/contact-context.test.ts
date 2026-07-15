import { describe, expect, it, vi } from "vitest";
import {
  CONTACT_TIMELINE_LOOKBACK_HOURS,
  TIMELINE_MAX_EVENTS,
  TIMELINE_MAX_LINE_CHARS,
  formatContactTimeline,
  loadContactTimeline,
  type ContactTimelineEvent
} from "../supabase/functions/_shared/contact_context";

const BIZ = "00000000-0000-0000-0000-000000000001";
const LEAD = "+15199560528";

// ---------------------------------------------------------------------------
// formatContactTimeline (pure)
// ---------------------------------------------------------------------------

const ev = (over: Partial<ContactTimelineEvent> = {}): ContactTimelineEvent => ({
  at: "2026-07-14T17:09:00Z",
  channel: "sms_in",
  text: "I am looking for auto insurance",
  ...over
});

describe("formatContactTimeline", () => {
  it("merges any input order into an oldest-first labeled timeline", () => {
    const text = formatContactTimeline([
      ev({
        at: "2026-07-14T17:10:22Z",
        channel: "sms_in",
        text: "July 23, 2026"
      }),
      ev({
        at: "2026-07-14T17:09:03Z",
        channel: "sms_out",
        text: "What prompted you to shop around today?"
      }),
      ev({
        at: "2026-07-14T16:00:00Z",
        channel: "voice",
        text: "(inbound call) Asked about auto insurance quotes."
      })
    ]);
    const lines = text!.split("\n");
    expect(lines[0]).toContain("Recent interactions with this contact across ALL channels");
    expect(lines[1]).toBe("- [Phone call] (inbound call) Asked about auto insurance quotes.");
    expect(lines[2]).toBe("- [Business (SMS)] What prompted you to shop around today?");
    expect(lines[3]).toBe("- [Contact (SMS)] July 23, 2026");
  });

  it("returns null when nothing is usable (empty, blank text, missing timestamp)", () => {
    expect(formatContactTimeline([])).toBeNull();
    expect(formatContactTimeline([ev({ text: "   " }), ev({ at: "" })])).toBeNull();
  });

  it("keeps the NEWEST events when over the cap and clips runaway lines", () => {
    const events = Array.from({ length: TIMELINE_MAX_EVENTS + 3 }, (_, i) =>
      ev({
        at: `2026-07-14T17:${String(10 + i).padStart(2, "0")}:00Z`,
        text: `message ${i}`
      })
    );
    events.push(
      ev({ at: "2026-07-14T18:00:00Z", text: `long   whitespace\n${"x".repeat(400)}` })
    );
    const text = formatContactTimeline(events)!;
    const lines = text.split("\n").slice(1);
    expect(lines).toHaveLength(TIMELINE_MAX_EVENTS);
    // The oldest events fell off the front (18 in, newest 14 kept).
    expect(text).not.toContain("message 0");
    expect(text).not.toContain("message 3");
    expect(text).toContain("message 4");
    // The runaway line is whitespace-collapsed and clipped with an ellipsis.
    const longLine = lines[lines.length - 1];
    expect(longLine).toContain("long whitespace x");
    expect(longLine).toContain("…");
    expect(longLine.length).toBeLessThanOrEqual(
      TIMELINE_MAX_LINE_CHARS + "- [Contact (SMS)] ".length
    );
  });
});

// ---------------------------------------------------------------------------
// loadContactTimeline (fake chainable client, one scripted result per await)
// ---------------------------------------------------------------------------

type Scripted = { data?: unknown; error?: unknown };

function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
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

/** The contact-resolve result for a plain (unmerged) contact. */
const PLAIN_CONTACT: Scripted = { data: { customer_e164: LEAD, alias_e164s: [] } };

/** A stored inbound job envelope the way telnyx-sms-inbound persists it. */
function inboundJob(text: string, createdAt: string) {
  return { created_at: createdAt, payload: { data: { payload: { text } } } };
}

describe("loadContactTimeline", () => {
  it("no contact number → null without touching the db", async () => {
    const { db, calls } = makeDb([]);
    expect(await loadContactTimeline(db, BIZ, "")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("merges inbound (incl. flow-suppressed), outbound (all sources), and call summaries", async () => {
    const { db, calls } = makeDb([
      PLAIN_CONTACT,
      // sms_inbound_jobs — newest-first, exactly like PostgREST returns.
      {
        data: [
          inboundJob("July 23, 2026", "2026-07-14T17:10:22Z"),
          inboundJob("I am looking for auto insurance", "2026-07-14T17:09:21Z")
        ]
      },
      // sms_outbound_log
      {
        data: [
          { created_at: "2026-07-14T17:10:05Z", body: "When does your policy renew?" },
          { created_at: "2026-07-14T17:09:03Z", body: "Hi Alex! What prompted you to shop around?" }
        ]
      },
      // voice_call_transcripts
      {
        data: [
          {
            started_at: "2026-07-14T18:00:00Z",
            created_at: "2026-07-14T18:00:01Z",
            direction: "inbound",
            summary: "Asked to confirm the broker call time.",
            status: "done"
          },
          {
            started_at: null,
            created_at: "2026-07-14T18:30:00Z",
            direction: "outbound",
            summary: null,
            status: "done"
          }
        ]
      }
    ]);
    const text = await loadContactTimeline(db, BIZ, LEAD);
    const lines = text!.split("\n");
    expect(lines.slice(1)).toEqual([
      "- [Business (SMS)] Hi Alex! What prompted you to shop around?",
      "- [Contact (SMS)] I am looking for auto insurance",
      "- [Business (SMS)] When does your policy renew?",
      "- [Contact (SMS)] July 23, 2026",
      "- [Phone call] (inbound call) Asked to confirm the broker call time.",
      "- [Phone call] (outbound call) call took place; summary not available yet"
    ]);

    // Wire shape: per-contact + lookback filters on all three sources; the
    // outbound query must NOT filter on source (the contact experienced
    // every send as one thread). The contact-number filter is an IN over
    // the profile's numbers (merged-alias awareness).
    expect(calls.filter((c) => c.name === "gte")).toHaveLength(3);
    const ins = calls.filter((c) => c.name === "in");
    expect(ins.map((c) => [c.table, c.args[0]])).toEqual([
      ["sms_inbound_jobs", "customer_e164"],
      ["sms_outbound_log", "to_e164"],
      ["voice_call_transcripts", "caller_e164"]
    ]);
    for (const c of ins) expect(c.args[1]).toEqual([LEAD]);
  });

  it("a merged contact's timeline spans the queried alias, the primary, and other aliases", async () => {
    const { db, calls } = makeDb([
      {
        data: {
          customer_e164: "+15550009999",
          alias_e164s: [LEAD, "+15550008888", "", 42 as unknown as string]
        }
      },
      { data: [inboundJob("from the old number", "2026-07-14T17:09:21Z")] },
      { data: [{ created_at: "2026-07-14T17:10:05Z", body: "to the new number" }] },
      { data: [] }
    ]);
    const text = await loadContactTimeline(db, BIZ, LEAD);
    expect(text).toContain("from the old number");
    expect(text).toContain("to the new number");
    const ins = calls.filter((c) => c.name === "in");
    // Queried number first, then the surviving primary, then usable aliases
    // (deduped; blank/non-string aliases dropped).
    for (const c of ins) {
      expect(c.args[1]).toEqual([LEAD, "+15550009999", "+15550008888"]);
    }
  });

  it("a contact-resolve failure degrades to the queried number alone", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, calls } = makeDb([
      { data: null, error: { message: "resolve boom" } },
      { data: [inboundJob("still works", "2026-07-14T17:09:21Z")] },
      { data: [] },
      { data: [] }
    ]);
    const text = await loadContactTimeline(db, BIZ, LEAD);
    expect(text).toContain("still works");
    const ins = calls.filter((c) => c.name === "in");
    for (const c of ins) expect(c.args[1]).toEqual([LEAD]);
    err.mockRestore();
  });

  it("excludes the inbound job being processed (its text is the current user message)", async () => {
    const { db, calls } = makeDb([
      PLAIN_CONTACT,
      { data: [inboundJob("earlier text", "2026-07-14T17:09:21Z")] },
      { data: [] },
      { data: [] }
    ]);
    await loadContactTimeline(db, BIZ, LEAD, { excludeInboundJobId: "job-42" });
    const neq = calls.find((c) => c.name === "neq");
    expect(neq?.args).toEqual(["id", "job-42"]);
  });

  it("per-source failures degrade to that source missing, never the whole block", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb([
      PLAIN_CONTACT,
      { data: null, error: { message: "inbound boom" } },
      { data: [{ created_at: "2026-07-14T17:09:03Z", body: "Hi Alex!" }] },
      { data: null, error: { message: "voice boom" } }
    ]);
    const text = await loadContactTimeline(db, BIZ, LEAD);
    expect(text).toContain("- [Business (SMS)] Hi Alex!");
    expect(err).toHaveBeenCalledTimes(2);

    // Outbound is the failing source this time; the other two still land.
    const { db: db2 } = makeDb([
      PLAIN_CONTACT,
      { data: [inboundJob("still here", "2026-07-14T17:09:21Z")] },
      { data: null, error: { message: "outbound boom" } },
      { data: [] }
    ]);
    const text2 = await loadContactTimeline(db2, BIZ, LEAD);
    expect(text2).toContain("- [Contact (SMS)] still here");
    expect(err).toHaveBeenCalledTimes(3);
    err.mockRestore();
  });

  it("empty results across every source → null; unusable rows are dropped", async () => {
    const { db } = makeDb([
      PLAIN_CONTACT,
      // Unusable inbound: no payload text; and a row with no timestamp.
      {
        data: [
          { created_at: "2026-07-14T17:09:21Z", payload: null },
          { created_at: null, payload: { data: { payload: { text: "no timestamp" } } } }
        ]
      },
      { data: [{ created_at: null, body: null }] },
      { data: null }
    ]);
    expect(await loadContactTimeline(db, BIZ, LEAD)).toBeNull();

    // Null data arms everywhere: no contact row (a first-ever inbound has
    // none yet) and PostgREST data:null on all three sources.
    const { db: db2 } = makeDb([
      { data: null },
      { data: null },
      { data: null },
      { data: null }
    ]);
    expect(await loadContactTimeline(db2, BIZ, LEAD)).toBeNull();
  });

  it("a call with neither started_at nor created_at is dropped; blank summaries fall to the placeholder", async () => {
    const { db } = makeDb([
      PLAIN_CONTACT,
      { data: [] },
      { data: [] },
      {
        data: [
          {
            started_at: null,
            created_at: null,
            direction: "inbound",
            summary: "orphan timestamps",
            status: "done"
          },
          {
            started_at: "2026-07-14T18:00:00Z",
            created_at: "2026-07-14T18:00:01Z",
            direction: null,
            summary: "   ",
            status: "done"
          }
        ]
      }
    ]);
    const text = await loadContactTimeline(db, BIZ, LEAD);
    expect(text).not.toContain("orphan timestamps");
    expect(text).toContain(
      "- [Phone call] (inbound call) call took place; summary not available yet"
    );
  });

  it("never throws: a client blow-up returns null", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await loadContactTimeline(db, BIZ, LEAD)).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("exports the lookback window callers share", () => {
    expect(CONTACT_TIMELINE_LOOKBACK_HOURS).toBe(72);
  });
});
