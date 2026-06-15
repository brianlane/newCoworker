import { describe, expect, it } from "vitest";

import { MAX_CC_BCC_RECIPIENTS, normalizeRecipients } from "@/lib/email/recipients";

describe("normalizeRecipients", () => {
  it("returns [] for nullish / non-string-or-array input", () => {
    expect(normalizeRecipients(undefined)).toEqual([]);
    expect(normalizeRecipients(null)).toEqual([]);
    expect(normalizeRecipients(42)).toEqual([]);
  });

  it("splits a comma/semicolon/whitespace separated string", () => {
    expect(normalizeRecipients("a@x.com, b@x.com; c@x.com d@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com"
    ]);
  });

  it("accepts an array, splitting each string entry and ignoring non-strings", () => {
    expect(normalizeRecipients(["a@x.com, b@x.com", 7 as unknown as string, "c@x.com"])).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com"
    ]);
  });

  it("lowercases, de-duplicates, and drops invalid / empty addresses", () => {
    expect(normalizeRecipients("A@X.com, a@x.com, not-an-email, , b@x.com")).toEqual([
      "a@x.com",
      "b@x.com"
    ]);
  });

  it("caps the result at the recipient limit", () => {
    const many = Array.from({ length: MAX_CC_BCC_RECIPIENTS + 5 }, (_, i) => `u${i}@x.com`);
    const out = normalizeRecipients(many);
    expect(out).toHaveLength(MAX_CC_BCC_RECIPIENTS);
    expect(out[0]).toBe("u0@x.com");
  });

  it("honors an explicit smaller cap", () => {
    expect(normalizeRecipients("a@x.com, b@x.com, c@x.com", 2)).toEqual(["a@x.com", "b@x.com"]);
  });
});
