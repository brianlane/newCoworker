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

  describe("multi-line trailers (pretty-printed / fenced) — the e2e-proven leak class", () => {
    const PRETTY_JSON = [
      "{",
      '  "intent": "gave_renewal_info",',
      '  "why": "lead answered the renewal timing question",',
      '  "handoff": true',
      "}"
    ].join("\n");

    it("strips a marker line followed by pretty-printed JSON, capturing the record", () => {
      // The instruction says "on its own final line", but models pretty-print:
      // line-based stripping used to remove ONLY the marker line and text the
      // entire reasoning JSON to the customer — and lose handoff:true, so the
      // needs-human escalation silently never fired.
      const raw = `Thanks for letting me know!\n${REASONING_MARKER}\n${PRETTY_JSON}`;
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe("Thanks for letting me know!");
      expect(res.reasoning).toEqual({
        intent: "gave_renewal_info",
        rationale: "lead answered the renewal timing question",
        escalated: true
      });
    });

    it("tolerates blank lines between the marker and the pretty JSON", () => {
      const raw = `See you then!\n${REASONING_MARKER}\n\n${PRETTY_JSON}`;
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe("See you then!");
      expect(res.reasoning?.intent).toBe("gave_renewal_info");
    });

    it("strips a trailer whose JSON opens on the marker line and closes later", () => {
      const raw =
        "On it!\n" +
        `${REASONING_MARKER}{"intent":"booking",\n"why":"they picked a time",\n"handoff":false}`;
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe("On it!");
      expect(res.reasoning?.intent).toBe("booking");
    });

    it("handles escaped quotes and braces inside multi-line trailer strings", () => {
      const raw =
        "Done!\n" +
        `${REASONING_MARKER}\n{\n  "intent": "notes",\n  "why": "said \\"use {curly} braces\\" today",\n  "handoff": false\n}`;
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe("Done!");
      expect(res.reasoning?.rationale).toBe('said "use {curly} braces" today');
    });

    it("strips a markerless pretty-printed trailer (bare `{` line, then \"intent\":)", () => {
      const raw = `Happy to help.\n{\n  "intent": "wants_quote",\n  "why": "asked about pricing",\n  "handoff": false\n}`;
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe("Happy to help.");
      expect(res.reasoning?.intent).toBe("wants_quote");
    });

    it("markerless bare `{` tolerates blank lines before the \"intent\" line", () => {
      const raw = `Got it.\n{\n\n  "intent": "note",\n  "why": "captured",\n  "handoff": false\n}`;
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe("Got it.");
      expect(res.reasoning?.intent).toBe("note");
    });

    it("a bare `{` line that is NOT a trailer stays in the reply", () => {
      // The bare-object net requires "intent": on the next non-blank line.
      const raw =
        "Here's the shape:\n{\nnot a trailer\n}\n" +
        `${REASONING_MARKER}{"intent":"a","why":"b","handoff":false}`;
      const res = splitReplyReasoning(raw);
      expect(res.reply).toContain("not a trailer");
      expect(res.reasoning?.intent).toBe("a");
    });

    it("a trailing bare `{` with nothing after it stays in the reply", () => {
      const raw = `${REASONING_MARKER}{"intent":"a","why":"b","handoff":false}\nP.S.\n{`;
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe("P.S.\n{");
      expect(res.reasoning?.intent).toBe("a");
    });

    it("removes fence-only debris lines when a fenced trailer was stripped", () => {
      const raw =
        "Happy to help with a quote!\n```json\n" +
        `${REASONING_MARKER}{"intent":"wants_quote","why":"asked for pricing","handoff":false}\n` +
        "```";
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe("Happy to help with a quote!");
      expect(res.reasoning?.intent).toBe("wants_quote");
    });

    it("keeps fence lines when nothing trailer-like was stripped", () => {
      const raw = "Steps:\n```\nnpm install\n```\nThat's it!";
      expect(splitReplyReasoning(raw)).toEqual({ reply: raw, reasoning: null });
    });

    it("a marker whose JSON never balances strips only the marker line", () => {
      const raw =
        `Real reply.\n${REASONING_MARKER}\n` +
        Array.from({ length: 15 }, (_, i) => `{ "line${i}":`).join("\n");
      const res = splitReplyReasoning(raw);
      // The unbalanced blob is NOT swallowed as a trailer (reply text after a
      // stray marker must never disappear) — but every `{`-bearing line here
      // still trips the bare-object/JSON nets independently or stays. The
      // first line survives untouched.
      expect(res.reply.startsWith("Real reply.")).toBe(true);
      expect(res.reasoning).toBeNull();
    });

    it("a marker line with no JSON anywhere strips just itself", () => {
      const raw = `Real reply text.\n${REASONING_MARKER}\nMore reply text.`;
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe("Real reply text.\nMore reply text.");
      expect(res.reasoning).toBeNull();
    });

    it("balances trailers whose JSON nests an inner object", () => {
      const raw =
        "All set!\n" +
        `${REASONING_MARKER}{"intent":"booking","why":"time agreed","meta":{"slot":"2pm"},"handoff":false}`;
      const res = splitReplyReasoning(raw);
      expect(res.reply).toBe("All set!");
      expect(res.reasoning?.intent).toBe("booking");
    });

    it("an opening brace glued to a sentence with the JSON below is a KNOWN unhandled shape (reply passes through)", () => {
      // Documented limitation: the bare-object net requires the `{` on its
      // own line — a `... {` sentence tail followed by pretty JSON has no
      // strippable line, so the text passes through untouched (the raw-level
      // gate matched, but nothing line-level did).
      const raw = 'Sounds good {\n"intent": "note"';
      expect(splitReplyReasoning(raw)).toEqual({ reply: raw, reasoning: null });
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
