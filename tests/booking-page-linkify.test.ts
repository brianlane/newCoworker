import { describe, expect, it } from "vitest";

import {
  linkifyText,
  trimTrailingUrlPunctuation
} from "@/lib/booking-page/linkify-text";

describe("trimTrailingUrlPunctuation", () => {
  it("strips trailing sentence punctuation", () => {
    expect(trimTrailingUrlPunctuation("https://example.com/.")).toBe(
      "https://example.com/"
    );
    expect(trimTrailingUrlPunctuation("https://example.com/,")).toBe(
      "https://example.com/"
    );
    expect(trimTrailingUrlPunctuation("https://example.com/]")).toBe(
      "https://example.com/"
    );
  });

  it("strips an unbalanced closing paren but keeps balanced path parens", () => {
    expect(trimTrailingUrlPunctuation("https://example.com/)")).toBe(
      "https://example.com/"
    );
    expect(trimTrailingUrlPunctuation("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe(
      "https://en.wikipedia.org/wiki/Foo_(bar)"
    );
  });

  it("returns empty when every character was trailing punctuation", () => {
    expect(trimTrailingUrlPunctuation("")).toBe("");
    expect(trimTrailingUrlPunctuation("...")).toBe("");
  });
});

describe("linkifyText", () => {
  it("returns empty for empty input", () => {
    expect(linkifyText("")).toEqual([]);
  });

  it("leaves plain text alone", () => {
    expect(linkifyText("Just a note")).toEqual([
      { type: "text", value: "Just a note" }
    ]);
  });

  it("linkifies a bare URL", () => {
    expect(linkifyText("https://example.com/path")).toEqual([
      { type: "url", value: "https://example.com/path" }
    ]);
  });

  it("linkifies a paren-wrapped URL like the Honed Tech intake label", () => {
    const label =
      "Please fill out the cost saving calculator before our meeting and paste answer below (https://honedtech.com/calculator/):";
    expect(linkifyText(label)).toEqual([
      {
        type: "text",
        value:
          "Please fill out the cost saving calculator before our meeting and paste answer below ("
      },
      { type: "url", value: "https://honedtech.com/calculator/" },
      { type: "text", value: "):" }
    ]);
  });

  it("matches URLs case-insensitively", () => {
    expect(linkifyText("(HTTPS://HONEDTECH.COM/CALCULATOR/)")).toEqual([
      { type: "text", value: "(" },
      { type: "url", value: "HTTPS://HONEDTECH.COM/CALCULATOR/" },
      { type: "text", value: ")" }
    ]);
  });

  it("keeps trailing punctuation outside the URL segment", () => {
    expect(linkifyText("See https://example.com/docs.")).toEqual([
      { type: "text", value: "See " },
      { type: "url", value: "https://example.com/docs" },
      { type: "text", value: "." }
    ]);
  });

  it("does not linkify non-http schemes", () => {
    expect(linkifyText("javascript:alert(1) and data:text/html,x")).toEqual([
      { type: "text", value: "javascript:alert(1) and data:text/html,x" }
    ]);
  });

  it("handles mixed text with multiple URLs", () => {
    expect(
      linkifyText("A https://a.example/ then https://b.example/x")
    ).toEqual([
      { type: "text", value: "A " },
      { type: "url", value: "https://a.example/" },
      { type: "text", value: " then " },
      { type: "url", value: "https://b.example/x" }
    ]);
  });
});
