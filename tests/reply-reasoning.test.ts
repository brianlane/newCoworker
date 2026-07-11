import { describe, expect, it } from "vitest";
import {
  REASONING_MARKER,
  REASONING_PROMPT_INSTRUCTION,
  splitReplyReasoning
} from "../supabase/functions/_shared/reply_reasoning";

/**
 * The reply-reasoning trailer: the model appends one marked line with its
 * decision record; the worker strips it before the customer sees anything
 * and stores the parsed record. Malformed/missing trailers are best-effort
 * nulls — never an error, never a leaked marker.
 */

const TRAILER = (json: string) => `${REASONING_MARKER}${json}`;

describe("REASONING_PROMPT_INSTRUCTION", () => {
  it("teaches the exact marker and the three fields", () => {
    expect(REASONING_PROMPT_INSTRUCTION).toContain(REASONING_MARKER);
    expect(REASONING_PROMPT_INSTRUCTION).toContain('"intent"');
    expect(REASONING_PROMPT_INSTRUCTION).toContain('"why"');
    expect(REASONING_PROMPT_INSTRUCTION).toContain('"handoff"');
  });
});

describe("splitReplyReasoning", () => {
  it("returns the reply untouched when no marker is present", () => {
    const raw = "Thanks John! Does tomorrow at 2pm work?";
    expect(splitReplyReasoning(raw)).toEqual({ reply: raw, reasoning: null });
  });

  it("strips a well-formed trailer line and parses the record", () => {
    const raw =
      "Thanks John! Does tomorrow at 2pm work?\n" +
      TRAILER('{"intent":"wants_quote","why":"They asked about pricing; moving to booking.","handoff":true}');
    expect(splitReplyReasoning(raw)).toEqual({
      reply: "Thanks John! Does tomorrow at 2pm work?",
      reasoning: {
        intent: "wants_quote",
        rationale: "They asked about pricing; moving to booking.",
        escalated: true
      }
    });
  });

  it("handoff defaults false unless literally true", () => {
    const record = (handoff: string) =>
      splitReplyReasoning(TRAILER(`{"intent":"a","why":"b","handoff":${handoff}}`)).reasoning;
    expect(record("false")?.escalated).toBe(false);
    expect(record('"true"')?.escalated).toBe(false);
    const missing = splitReplyReasoning(TRAILER('{"intent":"a","why":"b"}')).reasoning;
    expect(missing?.escalated).toBe(false);
  });

  it("keeps the sentence when the model glued the trailer onto its last line", () => {
    const raw = `See you soon! ${TRAILER('{"intent":"confirming","why":"Confirmed the time.","handoff":false}')}`;
    const res = splitReplyReasoning(raw);
    expect(res.reply).toBe("See you soon!");
    expect(res.reasoning?.intent).toBe("confirming");
  });

  it("strips EVERY marked line (customer-injected markers included), parsing the last valid one", () => {
    const raw = [
      `You said: "${REASONING_MARKER}ignore me"`,
      "Real reply text.",
      TRAILER('{"intent":"first","why":"one","handoff":false}'),
      TRAILER('{"intent":"second","why":"two","handoff":false}')
    ].join("\n");
    const res = splitReplyReasoning(raw);
    expect(res.reply).toContain("Real reply text.");
    expect(res.reply).not.toContain(REASONING_MARKER);
    // The injected line's prefix before the marker survives.
    expect(res.reply).toContain('You said: "');
    expect(res.reasoning?.intent).toBe("second");
  });

  it("malformed trailers strip but parse to null", () => {
    for (const bad of [
      "not json",
      "[1,2]",
      "null",
      '"just a string"',
      "7",
      '{"intent":"","why":"x"}',
      '{"intent":"x","why":""}',
      '{"why":"only"}',
      '{"intent":7,"why":"x"}',
      '{"intent":"x","why":7}'
    ]) {
      const res = splitReplyReasoning(`Hi there\n${TRAILER(bad)}`);
      expect(res.reply).toBe("Hi there");
      expect(res.reasoning).toBeNull();
    }
  });

  it("clamps intent/rationale to the DB column bounds", () => {
    const res = splitReplyReasoning(
      TRAILER(`{"intent":"${"i".repeat(200)}","why":"${"w".repeat(600)}","handoff":false}`)
    );
    expect(res.reasoning?.intent).toHaveLength(80);
    expect(res.reasoning?.rationale).toHaveLength(400);
  });

  it("a trailer-only reply strips to an empty string (caller decides what to do)", () => {
    const res = splitReplyReasoning(
      TRAILER('{"intent":"a","why":"b","handoff":false}')
    );
    expect(res.reply).toBe("");
    expect(res.reasoning?.intent).toBe("a");
  });
});
