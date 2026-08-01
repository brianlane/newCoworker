import { describe, expect, it } from "vitest";
import { truncateAtWord } from "../supabase/functions/_shared/text_truncate.ts";

describe("truncateAtWord", () => {
  it("returns short input trimmed and unmarked", () => {
    expect(truncateAtWord("  hello world  ", 20)).toBe("hello world");
  });

  it("returns input sitting exactly at the limit unchanged", () => {
    expect(truncateAtWord("abcde", 5)).toBe("abcde");
  });

  it("cuts at the last word boundary and appends an ellipsis", () => {
    expect(truncateAtWord("alpha beta gamma", 12)).toBe("alpha beta…");
  });

  it("keeps a whole word when the cut lands exactly at its end", () => {
    // The character just past the cut is the space after "beta": dropping the
    // "trailing partial word" here would throw away a word that fit.
    expect(truncateAtWord("alpha beta gamma", 11)).toBe("alpha beta…");
  });

  it("falls back to a mid-word cut when the first word alone overflows", () => {
    expect(truncateAtWord("Antidisestablishmentarianism", 10)).toBe("Antidises…");
  });

  it("collapses a whitespace run at the cut instead of keeping it", () => {
    expect(truncateAtWord("alpha beta   gamma delta", 15)).toBe("alpha beta…");
  });

  it("handles degenerate budgets", () => {
    expect(truncateAtWord("hello", 0)).toBe("");
    expect(truncateAtWord("hello", 1)).toBe("…");
    expect(truncateAtWord("", 5)).toBe("");
  });

  it("regression: the Amy Laidlaw Jul 31 2026 summary no longer ends mid-word", () => {
    const message =
      "New buyer lead Kolton Bottolfson is available today between 10am-2pm MST. " +
      "Looking for 3+ beds, 2+ baths, 2-3 car carport/garage, in the East Valley " +
      "(Mesa, AJ, or Gilbert). Budget around $412K. Jason Lane is the claimed agent.";
    const full = `Texter follow-up needed: ${message}`;
    const out = truncateAtWord(full, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
    const kept = out.slice(0, -1);
    expect(full.startsWith(kept)).toBe(true);
    // The old `.slice(0, 200)` ended "(Mesa, AJ, or Gilbert). Bud": the cut
    // must land between words, never inside "Budget".
    expect(/\s/.test(full.charAt(kept.length))).toBe(true);
    expect(kept.endsWith("Bud")).toBe(false);
  });
});
