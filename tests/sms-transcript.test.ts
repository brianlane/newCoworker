import { describe, expect, it, vi } from "vitest";
import {
  formatSmsTranscript,
  loadRecentSmsTranscript,
  TRANSCRIPT_MAX_EXCHANGES,
  TRANSCRIPT_MAX_LINE_CHARS
} from "../supabase/functions/_shared/sms_transcript";

/**
 * Recent-thread transcript for the stateless Rowboat retry: when the worker
 * drops a continuation, the freshly-rooted conversation must still know what
 * was already said, or the model restarts lead intake mid-thread (the Truly
 * Insurance 2026-07-13 incident — "what prompted you to shop around?" asked
 * three times).
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const LEAD = "+15485773546";

describe("formatSmsTranscript", () => {
  it("null when there is nothing worth saying", () => {
    expect(formatSmsTranscript([])).toBeNull();
    expect(formatSmsTranscript([{ inbound: "   ", reply: null }])).toBeNull();
    expect(formatSmsTranscript([{ inbound: "", reply: "  " }])).toBeNull();
  });

  it("renders Texter/You pairs oldest-first with the never-repeat header", () => {
    const text = formatSmsTranscript([
      { inbound: "I need auto insurance", reply: "What prompted you to shop around?" },
      { inbound: "August 1st", reply: null }
    ]);
    expect(text).toContain("ALREADY been said");
    expect(text).toContain("never repeat a line you already sent");
    const lines = text!.split("\n");
    expect(lines[1]).toBe("Texter: I need auto insurance");
    expect(lines[2]).toBe("You: What prompted you to shop around?");
    expect(lines[3]).toBe("Texter: August 1st");
    expect(lines).toHaveLength(4);
  });

  it("keeps only the newest TRANSCRIPT_MAX_EXCHANGES exchanges", () => {
    const exchanges = Array.from({ length: TRANSCRIPT_MAX_EXCHANGES + 3 }, (_, i) => ({
      inbound: `msg ${i}`,
      reply: `reply ${i}`
    }));
    const text = formatSmsTranscript(exchanges)!;
    expect(text).not.toContain("msg 0");
    expect(text).not.toContain("msg 2");
    expect(text).toContain("msg 3");
    expect(text).toContain(`msg ${TRANSCRIPT_MAX_EXCHANGES + 2}`);
  });

  it("clips long lines to the excerpt cap", () => {
    const text = formatSmsTranscript([
      { inbound: "x".repeat(TRANSCRIPT_MAX_LINE_CHARS + 100), reply: null }
    ])!;
    const line = text.split("\n")[1];
    expect(line).toHaveLength("Texter: ".length + TRANSCRIPT_MAX_LINE_CHARS);
    expect(line.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Loader (fake chainable client, one scripted result per terminal await)
// ---------------------------------------------------------------------------

type Scripted = { data?: unknown; error?: unknown };

function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "order", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

const jobRow = (text: string, reply: string | null) => ({
  payload: { data: { payload: { text } } },
  assistant_reply_text: reply
});

describe("loadRecentSmsTranscript", () => {
  it("assembles the thread oldest-first from newest-first job rows, excluding the current job", async () => {
    const { db, calls } = makeDb([
      {
        // Newest first, as the query returns them.
        data: [jobRow("second", "reply two"), jobRow("first", "reply one")]
      }
    ]);
    const text = await loadRecentSmsTranscript(db, BIZ, LEAD, "job-current");
    const lines = text!.split("\n");
    expect(lines[1]).toBe("Texter: first");
    expect(lines[2]).toBe("You: reply one");
    expect(lines[3]).toBe("Texter: second");
    expect(lines[4]).toBe("You: reply two");

    // Wire shape: done jobs for this contact, current job excluded.
    const eqStatus = calls.find((c) => c.name === "eq" && c.args[0] === "status");
    expect(eqStatus?.args[1]).toBe("done");
    const neqId = calls.find((c) => c.name === "neq");
    expect(neqId?.args).toEqual(["id", "job-current"]);
    const limit = calls.find((c) => c.name === "limit");
    expect(limit?.args[0]).toBe(TRANSCRIPT_MAX_EXCHANGES);
  });

  it("handles rows with a malformed envelope or missing reply", async () => {
    const { db } = makeDb([
      {
        data: [
          { payload: null, assistant_reply_text: "reply only" },
          { payload: { data: {} }, assistant_reply_text: null }
        ]
      }
    ]);
    const text = await loadRecentSmsTranscript(db, BIZ, LEAD, "job-x");
    expect(text).toContain("You: reply only");
    expect(text).not.toContain("Texter:");
  });

  it("null on empty history", async () => {
    const { db } = makeDb([{ data: [] }]);
    expect(await loadRecentSmsTranscript(db, BIZ, LEAD, "job-x")).toBeNull();
    const { db: nullDb } = makeDb([{ data: null }]);
    expect(await loadRecentSmsTranscript(nullDb, BIZ, LEAD, "job-x")).toBeNull();
  });

  it("degrades to null on query error; the retry proceeds bare", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb([{ data: null, error: { message: "boom" } }]);
    expect(await loadRecentSmsTranscript(db, BIZ, LEAD, "job-x")).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("never throws: a client blow-up returns null", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await loadRecentSmsTranscript(db, BIZ, LEAD, "job-x")).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
