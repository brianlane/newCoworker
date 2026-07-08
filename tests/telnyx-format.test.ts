import { describe, it, expect } from "vitest";
import {
  formatDid,
  normalizeContactNumber,
  normalizeDialableNumber
} from "@/lib/telnyx/format";

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

describe("normalizeContactNumber", () => {
  function value(raw: string): string {
    const r = normalizeContactNumber(raw);
    if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
    return r.value;
  }

  it("formats a pretty-printed US number to E.164 (the motivating case)", () => {
    expect(value("(305) 613-3412")).toBe("+13056133412");
  });

  it("accepts common US formattings and assumes +1 with no country code", () => {
    expect(value("305-613-3412")).toBe("+13056133412");
    expect(value("305.613.3412")).toBe("+13056133412");
    expect(value("305 613 3412")).toBe("+13056133412");
    expect(value("3056133412")).toBe("+13056133412");
  });

  it("treats a leading 1 (11 digits) as NANP", () => {
    expect(value("1 (305) 613-3412")).toBe("+13056133412");
    expect(value("13056133412")).toBe("+13056133412");
  });

  it("trusts an explicit + country code and only reformats it", () => {
    expect(value("+1 (305) 613-3412")).toBe("+13056133412");
    expect(value("+44 20 7123 4567")).toBe("+442071234567");
  });

  it("accepts international 00 prefix as a country code", () => {
    expect(value("0044 20 7123 4567")).toBe("+442071234567");
  });

  it("keeps bare 3-8 digit short codes as-is", () => {
    expect(value("72825")).toBe("72825");
    expect(value("73339")).toBe("73339");
  });

  it("rejects empty / blank input with a friendly reason", () => {
    expect(normalizeContactNumber("")).toEqual({
      ok: false,
      reason: "Enter a phone number or short code"
    });
    expect(normalizeContactNumber("   ").ok).toBe(false);
    expect(normalizeContactNumber(null).ok).toBe(false);
    expect(normalizeContactNumber(undefined).ok).toBe(false);
  });

  it("rejects non-numeric junk", () => {
    expect(normalizeContactNumber("not-a-number").ok).toBe(false);
  });

  it("rejects 9-digit bare input that is neither a short code nor NANP", () => {
    expect(normalizeContactNumber("123456789").ok).toBe(false);
  });

  it("rejects a + number that isn't structurally valid E.164", () => {
    expect(normalizeContactNumber("+1").ok).toBe(false);
  });
});

describe("normalizeDialableNumber", () => {
  it("assumes +1 for bare US numbers (the employee-add case)", () => {
    const r = normalizeDialableNumber("602-555-1234");
    expect(r).toEqual({ ok: true, value: "+16025551234" });
  });

  it("passes explicit country codes through", () => {
    const r = normalizeDialableNumber("+44 20 7123 4567");
    expect(r).toEqual({ ok: true, value: "+442071234567" });
  });

  it("refuses short codes (not dialable)", () => {
    const r = normalizeDialableNumber("72825");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("full phone number");
  });

  it("propagates the base rejection for junk input", () => {
    expect(normalizeDialableNumber("not-a-number").ok).toBe(false);
    expect(normalizeDialableNumber("").ok).toBe(false);
    expect(normalizeDialableNumber(null).ok).toBe(false);
  });

  it("rejects extension text instead of silently storing a wrong number", () => {
    const r = normalizeDialableNumber("+1 (602) 555-1234 x99");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("extensions");
    expect(normalizeDialableNumber("602-555-1234 ext 99").ok).toBe(false);
  });

  it("rejects a +1 number whose digits include a pasted extension", () => {
    const r = normalizeDialableNumber("+1 (602) 555-1234 99");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("10 digits");
  });
});
