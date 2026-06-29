import { describe, expect, it } from "vitest";
import { matchesQuery } from "@/lib/dashboard/search";

describe("matchesQuery", () => {
  it("matches everything for an empty or whitespace-only query", () => {
    expect(matchesQuery("", ["anything"])).toBe(true);
    expect(matchesQuery("   ", ["anything"])).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchesQuery("JANE", ["jane doe"])).toBe(true);
    expect(matchesQuery("jane", ["JANE DOE"])).toBe(true);
  });

  it("matches a substring across any field", () => {
    expect(matchesQuery("555", ["Jane", "+16025550100"])).toBe(true);
    expect(matchesQuery("doe", ["Jane Doe", null])).toBe(true);
  });

  it("requires every whitespace-separated term to match (AND)", () => {
    expect(matchesQuery("jane 555", ["Jane Doe", "+16025550100"])).toBe(true);
    expect(matchesQuery("jane 999", ["Jane Doe", "+16025550100"])).toBe(false);
  });

  it("ignores null/undefined/empty fields", () => {
    expect(matchesQuery("jane", [null, undefined, "", "Jane"])).toBe(true);
    expect(matchesQuery("jane", [null, undefined, ""])).toBe(false);
  });

  it("does not match a term spanning two separate fields", () => {
    // "ab" must not be found by concatenating field "a" + field "b".
    expect(matchesQuery("ab", ["a", "b"])).toBe(false);
    expect(matchesQuery("ab", ["zab"])).toBe(true);
  });

  it("returns false when no field matches", () => {
    expect(matchesQuery("xyz", ["Jane", "+16025550100"])).toBe(false);
  });
});
