import { describe, it, expect } from "vitest";
import { formatDid } from "@/lib/telnyx/format";

describe("formatDid", () => {
  it("pretty-prints a valid +1 NANP number", () => {
    expect(formatDid("+16025551234")).toBe("(602) 555-1234");
  });

  it("returns the input unchanged for non-NANP E.164", () => {
    expect(formatDid("+442071234567")).toBe("+442071234567");
  });

  it("returns the input unchanged for malformed strings", () => {
    expect(formatDid("not-a-number")).toBe("not-a-number");
  });

  it("returns empty string for null", () => {
    expect(formatDid(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(formatDid(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(formatDid("")).toBe("");
  });
});
