/**
 * Tests for the shared per-tenant webhook URL token check
 * (src/lib/integrations/webhook-token.ts), used by the Vagaro and Acuity
 * receivers.
 *
 * The length guard is not an optimization: timingSafeEqual THROWS on
 * mismatched buffer lengths, so without it a short attacker-supplied token
 * would crash the route instead of being rejected.
 */
import { describe, expect, it } from "vitest";

import { verificationTokenMatches } from "@/lib/integrations/webhook-token";
import { verificationTokenMatches as reExported } from "@/lib/vagaro/webhook";

describe("verificationTokenMatches", () => {
  it("accepts an exact match", () => {
    expect(verificationTokenMatches("tok123", "tok123")).toBe(true);
  });

  it("rejects a different token of the same length", () => {
    expect(verificationTokenMatches("tok123", "tok124")).toBe(false);
  });

  it("rejects a length mismatch without throwing", () => {
    expect(verificationTokenMatches("tok", "tok123")).toBe(false);
    expect(verificationTokenMatches("tok123456", "tok123")).toBe(false);
    expect(verificationTokenMatches("", "tok123")).toBe(false);
  });

  it("treats two empty tokens as equal (callers gate on presence first)", () => {
    expect(verificationTokenMatches("", "")).toBe(true);
  });

  it("stays re-exported from the Vagaro module so existing importers work", () => {
    expect(reExported).toBe(verificationTokenMatches);
  });
});
