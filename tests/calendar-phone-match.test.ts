import { describe, expect, it } from "vitest";

import {
  digitsOf,
  MIN_PHONE_MATCH_DIGITS,
  phoneDigitsMatch
} from "@/lib/calendar-tools/phone-match";

/**
 * Format- and country-code-tolerant phone comparison shared by the
 * appointment-lifecycle lookups. E.164 and national forms of the same
 * number must agree; short fragments must not match real numbers.
 */

describe("digitsOf", () => {
  it("strips every non-digit", () => {
    expect(digitsOf("+1 (548) 577-3546")).toBe("15485773546");
    expect(digitsOf("ext. abc")).toBe("");
  });
});

describe("phoneDigitsMatch", () => {
  it("matches E.164 against the national form in both directions", () => {
    expect(phoneDigitsMatch("15485773546", "5485773546")).toBe(true);
    expect(phoneDigitsMatch("5485773546", "15485773546")).toBe(true);
    expect(phoneDigitsMatch("15485773546", "15485773546")).toBe(true);
  });

  it("rejects different numbers and shared-suffix lookalikes", () => {
    expect(phoneDigitsMatch("15485773546", "15550001111")).toBe(false);
    // Same last digits, different subscriber prefix — no suffix relation.
    expect(phoneDigitsMatch("15485773546", "15495773547")).toBe(false);
  });

  it("short strings only match on exact equality — never as a suffix", () => {
    const short = "773546"; // below MIN_PHONE_MATCH_DIGITS
    expect(short.length).toBeLessThan(MIN_PHONE_MATCH_DIGITS);
    expect(phoneDigitsMatch(short, "15485773546")).toBe(false);
    expect(phoneDigitsMatch("15485773546", short)).toBe(false);
    expect(phoneDigitsMatch(short, short)).toBe(true);
    expect(phoneDigitsMatch("", "")).toBe(false);
    expect(phoneDigitsMatch("", short)).toBe(false);
  });
});
