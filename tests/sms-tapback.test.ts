import { describe, expect, it } from "vitest";
import {
  formatTapbackAnswerNote,
  isTapbackText,
  parseTapback,
  tapbackKind
} from "../supabase/functions/_shared/sms_tapback";

/**
 * Tapback detection (sms_tapback.ts): the shapes phones render over SMS must
 * match; anything a human could plausibly type must not. Two production
 * triggers: KYP Ads 2026-07-20, a customer's Like (`Liked “Great, looking
 * forward to it!”`) got an AI reply; KYP 2026-07-28, three verbless hearts
 * in a row each got one.
 */

/**
 * Byte-for-byte the third inbound from the 2026-07-28 KYP thread (+1 720 843
 * 8676), codepoints confirmed against the row. The hair spaces (U+200A) trim
 * away on their own; the zero-width spaces (U+200B) hugging the heart do not,
 * which is exactly what defeated the pre-fix patterns.
 */
const LIVE_VERBLESS_HEART =
  "\u200A\u200B\u2764\uFE0F\u200B to \u201C\u200AI am sorry for the wait on that. " +
  "I have flagged this directly to James so he can get that email breakdown " +
  "over to you right away.\u200A\u201D\u200A";

describe("isTapbackText", () => {
  it("matches all six classic tapback verbs (curly quotes)", () => {
    for (const verb of ["Liked", "Loved", "Disliked", "Laughed at", "Emphasized", "Questioned"]) {
      expect(isTapbackText(`${verb} \u201CGreat, looking forward to it!\u201D`)).toBe(true);
    }
  });

  it("matches straight quotes and the British Emphasised spelling", () => {
    expect(isTapbackText('Liked "See you then"')).toBe(true);
    expect(isTapbackText("Emphasised \u201CBooking only takes a minute\u201D")).toBe(true);
  });

  it("matches removal forms", () => {
    for (const noun of [
      "a like",
      "a heart",
      "a dislike",
      "a laugh",
      "an exclamation",
      "an exclamation point",
      "a question mark"
    ]) {
      expect(isTapbackText(`Removed ${noun} from \u201CSee you then\u201D`)).toBe(true);
    }
  });

  it("matches iOS 18 emoji tapbacks (reacted / removed)", () => {
    expect(isTapbackText("Reacted \u{1F525} to \u201CSee you then\u201D")).toBe(true);
    expect(isTapbackText("Reacted \u{1F44D}\u{1F3FD} to \u201CSee you then\u201D")).toBe(true);
    expect(isTapbackText("Removed \u{1F525} from \u201CSee you then\u201D")).toBe(true);
  });

  it("matches the verbless rendering, including the live KYP heart", () => {
    expect(isTapbackText(LIVE_VERBLESS_HEART)).toBe(true);
    expect(isTapbackText("\u2764\uFE0F to \u201CSee you then\u201D")).toBe(true);
    expect(isTapbackText("\u{1F44E} to \u201CSee you then\u201D")).toBe(true);
    expect(isTapbackText("\u{1F642}\u200D\u2195\uFE0F to \u201CSee you then\u201D")).toBe(true);
    expect(isTapbackText("\u{1F44D} from \u201CSee you then\u201D")).toBe(true);
  });

  it("matches when the quoted original spans multiple lines", () => {
    expect(
      isTapbackText("Liked \u201CZoom link:\nhttps://example.zoom.us/j/123\nSee you then!\u201D")
    ).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isTapbackText("  Liked \u201Cok\u201D \n")).toBe(true);
  });

  it("never matches genuine sentences that start with a tapback verb", () => {
    expect(isTapbackText("Loved it!")).toBe(false);
    expect(isTapbackText("Liked your proposal, let's talk tomorrow")).toBe(false);
    expect(isTapbackText("Loved the demo \u2014 when can we start?")).toBe(false);
    // Trailing content after the quoted body = a real message.
    expect(isTapbackText("Liked \u201Cthe plan\u201D but I have questions")).toBe(false);
    // Leading content before the verb = a real message.
    expect(isTapbackText("I Liked \u201Cthe plan\u201D")).toBe(false);
  });

  it("never matches 'reacted' sentences with a word where the emoji goes", () => {
    expect(isTapbackText("Reacted quickly to \u201Cthe news\u201D")).toBe(false);
    expect(isTapbackText("Removed my name from \u201Cthe list\u201D")).toBe(false);
  });

  it("never matches a verbless opener that is not an emoji", () => {
    // The verbless form has no verb to anchor on, so a non-emoji leading
    // token must never qualify.
    expect(isTapbackText('+1 to \u201Cgreat idea\u201D')).toBe(false);
    expect(isTapbackText('? to \u201Cthe quote\u201D')).toBe(false);
    expect(isTapbackText("Yes to \u201Cthe 2pm slot\u201D")).toBe(false);
    expect(isTapbackText("No from \u201Cthe list\u201D")).toBe(false);
    // Emoji present but the quoted body does not span the rest.
    expect(isTapbackText("\u2764\uFE0F to \u201Cthe plan\u201D but call me")).toBe(false);
    expect(isTapbackText("\u2764\uFE0F to you both")).toBe(false);
  });

  it("never matches unquoted, empty, or degenerate inputs", () => {
    expect(isTapbackText("")).toBe(false);
    expect(isTapbackText("   ")).toBe(false);
    expect(isTapbackText("Liked")).toBe(false);
    expect(isTapbackText("Liked \u201Cunclosed")).toBe(false);
    expect(isTapbackText("Hey, Yes. I will be there")).toBe(false);
    expect(isTapbackText("What time zone is that?")).toBe(false);
  });
});

/**
 * The kind drives whether the worker suppresses the reply: removals always
 * suppressed, question marks always answered, everything else gated on
 * whether our last message asked something.
 */
describe("tapbackKind", () => {
  it("classifies removals, in every rendering", () => {
    expect(tapbackKind("Removed a like from \u201CSee you then\u201D")).toBe("removal");
    expect(tapbackKind("Removed \u{1F525} from \u201CSee you then\u201D")).toBe("removal");
    expect(tapbackKind("\u2764\uFE0F from \u201CSee you then\u201D")).toBe("removal");
    // A removed question mark is still cleanup, not a question.
    expect(tapbackKind("Removed a question mark from \u201CSee you then\u201D")).toBe("removal");
  });

  it("classifies question marks, verb and emoji spellings alike", () => {
    expect(tapbackKind("Questioned \u201CWe close at 5\u201D")).toBe("question");
    expect(tapbackKind("Reacted \u2753 to \u201CWe close at 5\u201D")).toBe("question");
    expect(tapbackKind("\u2754 to \u201CWe close at 5\u201D")).toBe("question");
  });

  it("classifies every other reaction as a plain reaction", () => {
    expect(tapbackKind("Liked \u201CSee you then\u201D")).toBe("reaction");
    expect(tapbackKind("Disliked \u201CSee you then\u201D")).toBe("reaction");
    expect(tapbackKind(LIVE_VERBLESS_HEART)).toBe("reaction");
    expect(tapbackKind("\u{1F44E} to \u201CDoes noon work?\u201D")).toBe("reaction");
    expect(tapbackKind("\u{1F42C} to \u201CDoes noon work?\u201D")).toBe("reaction");
  });

  it("is null for a real message", () => {
    expect(tapbackKind("Loved it!")).toBe(null);
    expect(tapbackKind("")).toBe(null);
  });
});

describe("parseTapback", () => {
  it("recovers the reaction and the message it reacted to", () => {
    expect(parseTapback(LIVE_VERBLESS_HEART)).toEqual({
      kind: "reaction",
      reaction: "\u2764\uFE0F",
      quoted:
        "I am sorry for the wait on that. I have flagged this directly to James " +
        "so he can get that email breakdown over to you right away."
    });
    expect(parseTapback("Liked \u201CDoes noon work?\u201D")).toEqual({
      kind: "reaction",
      reaction: "Liked",
      quoted: "Does noon work?"
    });
  });
});

describe("formatTapbackAnswerNote", () => {
  it("tells the model what the reaction answers, and how to read a no", () => {
    const note = formatTapbackAnswerNote({
      kind: "reaction",
      reaction: "\u{1F44E}",
      quoted: "Does noon work for you?"
    });
    expect(note).toContain("\u{1F44E}");
    expect(note).toContain("Does noon work for you?");
    expect(note).toContain("means no");
    expect(note).toContain("ask it again in plain words");
  });

  it("asks for a re-explanation on a question-mark reaction", () => {
    const note = formatTapbackAnswerNote({
      kind: "question",
      reaction: "\u2753",
      quoted: "We close at 5"
    });
    expect(note).toContain("did not understand");
    expect(note).not.toContain("means no");
  });

  it("truncates a long quoted message", () => {
    const note = formatTapbackAnswerNote({
      kind: "reaction",
      reaction: "\u2764\uFE0F",
      quoted: "x".repeat(500)
    });
    expect(note).toContain("\u2026");
    expect(note.length).toBeLessThan(700);
  });

  it("never writes an em dash (README writing rule)", () => {
    for (const kind of ["reaction", "question"] as const) {
      expect(
        formatTapbackAnswerNote({ kind, reaction: "\u2764\uFE0F", quoted: "See you then" })
      ).not.toContain("\u2014");
    }
  });
});
