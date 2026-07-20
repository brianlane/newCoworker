import { describe, expect, it } from "vitest";
import { isTapbackText } from "../supabase/functions/_shared/sms_tapback";

/**
 * iMessage tapback detection (sms_tapback.ts): the shapes Apple renders
 * over SMS must match; anything a human could plausibly type must not.
 * The production trigger: KYP Ads 2026-07-20, a customer's Like
 * (`Liked “Great, looking forward to it!”`) got an AI reply.
 */
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

  it("never matches unquoted, empty, or degenerate inputs", () => {
    expect(isTapbackText("")).toBe(false);
    expect(isTapbackText("   ")).toBe(false);
    expect(isTapbackText("Liked")).toBe(false);
    expect(isTapbackText("Liked \u201Cunclosed")).toBe(false);
    expect(isTapbackText("Hey, Yes. I will be there")).toBe(false);
    expect(isTapbackText("What time zone is that?")).toBe(false);
  });
});
