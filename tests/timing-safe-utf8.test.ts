import { describe, it, expect } from "vitest";
import { timingSafeEqualUtf8 } from "@/lib/timing-safe-utf8";

describe("timingSafeEqualUtf8", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualUtf8("secret-token", "secret-token")).toBe(true);
  });

  it("returns false for different strings of equal UTF-8 byte length", () => {
    expect(timingSafeEqualUtf8("secret-a", "secret-b")).toBe(false);
  });

  it("returns false without throwing when JS lengths match but UTF-8 byte lengths differ", () => {
    // Both have string length 1; "a" is 1 UTF-8 byte, "é" is 2.
    expect(timingSafeEqualUtf8("a", "é")).toBe(false);
    expect(timingSafeEqualUtf8("é", "a")).toBe(false);
  });

  it("returns false when UTF-8 lengths differ (including empty vs non-empty)", () => {
    expect(timingSafeEqualUtf8("", "x")).toBe(false);
    expect(timingSafeEqualUtf8("x", "")).toBe(false);
  });
});
