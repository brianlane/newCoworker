/**
 * Blog copy policy (src/lib/blog/copy.ts): em dashes are banned from all
 * post copy — replacement joints, punctuation cleanup, draft/field
 * helpers.
 */
import { describe, expect, it } from "vitest";
import {
  sanitizeBlogCopyFields,
  stripEmDashes,
  stripEmDashesFromDraft
} from "@/lib/blog/copy";

describe("stripEmDashes", () => {
  it("replaces spaced and unspaced em dashes with a comma joint", () => {
    expect(stripEmDashes("fast — really fast")).toBe("fast, really fast");
    expect(stripEmDashes("fast—really fast")).toBe("fast, really fast");
    expect(stripEmDashes("a — b — c")).toBe("a, b, c");
  });

  it("handles the horizontal bar and collapses runs", () => {
    expect(stripEmDashes("a ― b")).toBe("a, b");
    expect(stripEmDashes("a —— b")).toBe("a, b");
  });

  it("cleans punctuation artifacts from leading/trailing dashes", () => {
    expect(stripEmDashes("done —.")).toBe("done.");
    expect(stripEmDashes("— leading line")).toBe("leading line");
    expect(stripEmDashes("trailing line —")).toBe("trailing line");
    expect(stripEmDashes("multi\n— line start\nline end —")).toBe(
      "multi\nline start\nline end"
    );
  });

  it("leaves hyphens, en dashes, and markdown separators alone", () => {
    expect(stripEmDashes("well-known 9–5 shop")).toBe("well-known 9–5 shop");
    expect(stripEmDashes("| --- | --- |")).toBe("| --- | --- |");
    expect(stripEmDashes("no dashes here")).toBe("no dashes here");
  });
});

describe("stripEmDashesFromDraft / sanitizeBlogCopyFields", () => {
  it("strips every string field of a draft", () => {
    expect(
      stripEmDashesFromDraft({ title: "A — B", excerpt: "C—D", content: "E — F" })
    ).toEqual({ title: "A, B", excerpt: "C, D", content: "E, F" });
  });

  it("sanitizes only the copy fields of an admin payload, leaving the rest", () => {
    const body = {
      title: "A — B",
      excerpt: "C — D",
      content: "E — F",
      title_es: "G — H",
      excerpt_es: null,
      category: "feature",
      featured_image_path: "x—y.png"
    };
    expect(sanitizeBlogCopyFields(body)).toEqual({
      title: "A, B",
      excerpt: "C, D",
      content: "E, F",
      title_es: "G, H",
      excerpt_es: null,
      category: "feature",
      featured_image_path: "x—y.png"
    });
  });
});
