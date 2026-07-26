import { describe, expect, it } from "vitest";
import {
  formatUsd,
  groupRepeatedQuestions,
  normalizeQuestion,
  summarizeSurfaces
} from "../debug/repeat-cognition";
import { isCarrierFailure, matchesInbound, normalizeE164, parseSince } from "../debug/trace-sms";
import { tally } from "../debug/audit-account";

/**
 * Unit coverage for the pure helpers behind the three read-only investigation
 * CLIs in `debug/`. Their IO is live-fleet dependent and untested by design
 * (see debug/README.md); what is pinned here is the logic that decides what
 * the operator is told.
 *
 * The grouping rules in `repeat-cognition` matter most: they decide whether a
 * surface gets called a caching opportunity, and overstating that would lead
 * straight to building a cache that buys nothing.
 *
 * `debug/**` is outside the coverage `include`, so these add assertions
 * without moving the 100% thresholds.
 */

describe("normalizeQuestion", () => {
  it("folds case, punctuation, and whitespace so one question groups as one", () => {
    expect(normalizeQuestion("What are your HOURS?")).toBe("what are your hours");
    expect(normalizeQuestion("  what   are your hours  ")).toBe("what are your hours");
  });

  it("keeps genuinely different questions apart", () => {
    expect(normalizeQuestion("what are your hours")).not.toBe(normalizeQuestion("where are you located"));
  });
});

describe("groupRepeatedQuestions", () => {
  const at = (n: number) => `2026-07-${String(n).padStart(2, "0")}T00:00:00Z`;

  it("groups differently-typed askings of one question and marks a stable answer cacheable", () => {
    const groups = groupRepeatedQuestions(
      [
        { business_id: "b1", question: "What are your hours?", answer: "9 to 5.", created_at: at(1) },
        { business_id: "b1", question: "what are your hours", answer: "9 to 5.", created_at: at(3) }
      ],
      2
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ asked: 2, distinctAnswers: 1, stable: true, lastAskedAt: at(3) });
  });

  it("marks a group whose answers differ as NOT cacheable", () => {
    const groups = groupRepeatedQuestions(
      [
        { business_id: "b1", question: "Do you have availability?", answer: "Tuesday.", created_at: at(1) },
        { business_id: "b1", question: "do you have availability", answer: "Thursday.", created_at: at(2) }
      ],
      2
    );
    expect(groups[0].stable).toBe(false);
    expect(groups[0].distinctAnswers).toBe(2);
  });

  it("never merges the same question asked at two different businesses", () => {
    const groups = groupRepeatedQuestions(
      [
        { business_id: "b1", question: "what are your hours", answer: "9 to 5.", created_at: at(1) },
        { business_id: "b2", question: "what are your hours", answer: "10 to 6.", created_at: at(1) }
      ],
      1
    );
    expect(groups).toHaveLength(2);
  });

  it("honors the minimum-repeats floor and sorts by volume", () => {
    const rows = [
      { business_id: "b1", question: "a?", answer: "x", created_at: at(1) },
      { business_id: "b1", question: "b?", answer: "y", created_at: at(1) },
      { business_id: "b1", question: "b?", answer: "y", created_at: at(2) },
      { business_id: "b1", question: "b?", answer: "y", created_at: at(3) }
    ];
    expect(groupRepeatedQuestions(rows, 2).map((g) => g.asked)).toEqual([3]);
    expect(groupRepeatedQuestions(rows, 1).map((g) => g.asked)).toEqual([3, 1]);
  });

  it("ignores rows whose question normalizes to nothing", () => {
    expect(groupRepeatedQuestions([{ business_id: "b1", question: "???", answer: "x", created_at: at(1) }], 1)).toEqual(
      []
    );
  });
});

describe("summarizeSurfaces", () => {
  it("sums cost and calls per surface, highest spend first, with a per-call rate", () => {
    const summary = summarizeSurfaces([
      { surface: "knowledge_lookup", model: "gemini-3.5-flash", cost_micros: 40_000, call_count: 8 },
      { surface: "knowledge_lookup", model: "gemini-3.6-flash", cost_micros: 10_000, call_count: 2 },
      { surface: "dashboard_chat", model: "gemini-3.6-flash", cost_micros: 690_000, call_count: 47 }
    ]);
    expect(summary.map((s) => s.surface)).toEqual(["dashboard_chat", "knowledge_lookup"]);
    expect(summary[1]).toMatchObject({ calls: 10, costMicros: 50_000, microsPerCall: 5_000 });
    expect(summary[1].models).toEqual(["gemini-3.5-flash", "gemini-3.6-flash"]);
  });

  it("does not divide by zero when a surface recorded no calls", () => {
    expect(summarizeSurfaces([{ surface: "s", model: "m", cost_micros: 0, call_count: 0 }])[0].microsPerCall).toBe(0);
  });
});

describe("formatUsd", () => {
  it("renders micros as dollars", () => {
    expect(formatUsd(1_234_567)).toBe("$1.23");
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("trace-sms helpers", () => {
  it("reads a phone number in whatever shape it was pasted", () => {
    expect(normalizeE164("+14805551234")).toBe("+14805551234");
    expect(normalizeE164("(480) 555-1234")).toBe("+14805551234");
    expect(normalizeE164("1-480-555-1234")).toBe("+14805551234");
    expect(normalizeE164(" 480.555.1234 ")).toBe("+14805551234");
  });

  it("refuses input it cannot read rather than silently searching for the wrong number", () => {
    // Answering "no messages found" for a misparsed number is the worst
    // possible outcome for this tool, so it throws instead.
    expect(() => normalizeE164("555-1234")).toThrow(/could not read/);
  });

  it("parses relative windows and rejects nonsense", () => {
    expect(parseSince("90m")).toBe(90 * 60_000);
    expect(parseSince("36h")).toBe(36 * 3_600_000);
    expect(parseSince("7d")).toBe(7 * 86_400_000);
    expect(() => parseSince("soon")).toThrow(/--since/);
  });

  it("matches an inbound job by its denormalized column", () => {
    expect(matchesInbound({ customer_e164: "+14805551234", payload: null }, "+14805551234")).toBe(true);
    expect(matchesInbound({ customer_e164: "+14805559999", payload: null }, "+14805551234")).toBe(false);
  });

  it("falls back to the payload when the column is null or diverged", () => {
    // Column-only matching reported "the customer never texted" for threads
    // the dashboard renders, because the reader finds these by payload.
    const payload = { data: { payload: { from: { phone_number: "+14805551234" } } } };
    expect(matchesInbound({ customer_e164: null, payload }, "+14805551234")).toBe(true);
    expect(matchesInbound({ customer_e164: "4805551234", payload }, "+14805551234")).toBe(true);
  });

  it("drops a row that matches neither", () => {
    expect(matchesInbound({ customer_e164: null, payload: null }, "+14805551234")).toBe(false);
  });
});

describe("audit-account helpers", () => {
  it("tallies statuses highest-first", () => {
    expect(tally(["done", "failed", "done", "done", "failed"])).toEqual([
      ["done", 3],
      ["failed", 2]
    ]);
    expect(tally([])).toEqual([]);
  });
});

describe("trace-sms carrier verdicts", () => {
  const outbound = (over: Partial<Parameters<typeof isCarrierFailure>[0]>) =>
    ({
      at: "2026-07-26T00:00:00Z",
      direction: "outbound" as const,
      businessId: "b1",
      detail: "",
      body: "",
      ...over
    });

  it("counts a tracked send the carrier did not confirm as a carrier failure", () => {
    expect(isCarrierFailure(outbound({ telnyxTracked: true, carrier: "sending_failed" }))).toBe(true);
  });

  it("does not blame the carrier for a send we never handed to Telnyx", () => {
    // "no telnyx id recorded" means OUR side has no handoff record. Counting
    // it as undelivered would point the investigation at the carrier for a
    // failure that happened before the carrier was ever involved.
    expect(isCarrierFailure(outbound({ telnyxTracked: false, carrier: "no telnyx id recorded" }))).toBe(false);
  });

  it("treats a delivered verdict as success and an absent verdict as unknown", () => {
    expect(isCarrierFailure(outbound({ telnyxTracked: true, carrier: "delivered" }))).toBe(false);
    expect(isCarrierFailure(outbound({ telnyxTracked: true, carrier: null }))).toBe(false);
  });

  it("never flags an inbound event", () => {
    expect(isCarrierFailure(outbound({ direction: "inbound", telnyxTracked: true, carrier: "failed" }))).toBe(false);
  });
});
