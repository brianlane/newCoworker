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

  it("the canonical marker is plain ASCII (models must reproduce it byte-perfectly)", () => {
    // The original ⟦reasoning⟧ marker leaked to a customer when the model
    // mangled the exotic brackets. Never reintroduce non-ASCII here.
    expect(REASONING_MARKER).toMatch(/^[ -~]+$/);
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

  describe("mangled-marker tolerance (production leak, Truly Insurance 2026-07-11)", () => {
    // The model rewrote ⟦reasoning⟧ as `⟦reasoning}` and displaced the `⟧`
    // to the very end of the line; the old exact-match stripper found
    // nothing and the whole trailer was texted to the customer. Every
    // variant here must strip AND parse.
    const JSON_BODY =
      '{"intent":"renew_insurance_policy","why":"Their policy lapsed; asking for contact details.","handoff":false}';

    it("strips the exact leaked shape: mangled opener + displaced closer", () => {
      const raw =
        "Thanks for reaching out to Truly Insurance. I'll help get you connected.\n\n" +
        "What's the best way to reach you by phone or email?\n" +
        `\u27E6reasoning}${JSON_BODY}\u27E7`;
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe(
        "Thanks for reaching out to Truly Insurance. I'll help get you connected.\n\n" +
          "What's the best way to reach you by phone or email?"
      );
      expect(res.reasoning).toEqual({
        intent: "renew_insurance_policy",
        rationale: "Their policy lapsed; asking for contact details.",
        escalated: false
      });
    });

    it.each([
      ["legacy unicode marker", `\u27E6reasoning\u27E7${JSON_BODY}`],
      ["single ASCII brackets", `[reasoning]${JSON_BODY}`],
      ["canonical doubled brackets", `[[reasoning]]${JSON_BODY}`],
      ["unclosed opener", `[[reasoning${JSON_BODY}`],
      ["inner whitespace and case", `[[ Reasoning ]] ${JSON_BODY}`]
    ])("strips and parses the %s variant", (_label, trailer) => {
      const res = splitReplyReasoning(`Sounds good, see you then!\n${trailer}`);
      expect(res.reply).toBe("Sounds good, see you then!");
      expect(res.reasoning?.intent).toBe("renew_insurance_policy");
    });
  });

  describe("markerless trailer JSON (caught live by the e2e suite, 2026-07-11)", () => {
    // The model sometimes replaces the marker word with free-form reasoning
    // text — `[[<summary>]] {"intent":...}` — which no marker matcher can
    // see. The trailer JSON itself is the second net: no customer-facing
    // reply legitimately contains `{"intent":"`.
    it("strips the exact live-caught shape: bracket blob + bare trailer JSON", () => {
      const raw =
        "I understand. I'll have your broker reach out to you directly to discuss your options. " +
        "[[Dwight's truck is parked and he's paying for it. He needs insurance and his policy expired.]] " +
        '{"intent":"find new insurance","why":"Dwight needs new insurance because his old policy was not renewed.","handoff":true}';
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe(
        "I understand. I'll have your broker reach out to you directly to discuss your options."
      );
      expect(res.reasoning).toEqual({
        intent: "find new insurance",
        rationale: "Dwight needs new insurance because his old policy was not renewed.",
        escalated: true
      });
    });

    it("strips a unicode-bracket blob in front of the JSON", () => {
      const raw =
        "See you tomorrow at 2pm!\n" +
        '\u27E6confirming the booking\u27E7 {"intent":"confirming","why":"Time agreed.","handoff":false}';
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe("See you tomorrow at 2pm!");
      expect(res.reasoning?.intent).toBe("confirming");
    });

    it("strips bare trailer JSON with no marker or blob at all", () => {
      const raw =
        'Happy to help with that.\n{"intent":"wants_quote","why":"Asked about pricing.","handoff":false}';
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe("Happy to help with that.");
      expect(res.reasoning?.intent).toBe("wants_quote");
    });

    it("keeps the sentence when the bare JSON is glued onto it", () => {
      const raw = 'Sounds good! {"intent":"confirming","why":"They agreed.","handoff":false}';
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe("Sounds good!");
      expect(res.reasoning?.intent).toBe("confirming");
    });
  });

  it("malformed trailers strip but parse to null", () => {
    for (const bad of [
      "not json",
      '{"intent": nope}',
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
