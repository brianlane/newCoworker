import { describe, expect, it } from "vitest";

import { brandingSchema, parseBranding, effectiveBranding } from "@/lib/plans/branding";

describe("brandingSchema", () => {
  it("accepts a full valid config", () => {
    const parsed = brandingSchema.parse({
      productName: "Acme Assistant",
      logoUrl: "https://cdn.example.com/logo.png",
      accentColor: "#22c55e"
    });
    expect(parsed.productName).toBe("Acme Assistant");
  });

  it("accepts partial configs and strips unknown keys", () => {
    const parsed = brandingSchema.parse({ productName: "Acme", extra: "nope" });
    expect(parsed).toEqual({ productName: "Acme" });
  });

  it("rejects non-https logos, bad colors, and short names", () => {
    expect(brandingSchema.safeParse({ logoUrl: "http://x.com/l.png" }).success).toBe(false);
    expect(brandingSchema.safeParse({ logoUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(brandingSchema.safeParse({ accentColor: "red" }).success).toBe(false);
    expect(brandingSchema.safeParse({ accentColor: "#22c55e99" }).success).toBe(false);
    expect(brandingSchema.safeParse({ productName: "A" }).success).toBe(false);
  });

  it("accepts #rgb shorthand colors", () => {
    expect(brandingSchema.safeParse({ accentColor: "#0f0" }).success).toBe(true);
  });
});

describe("parseBranding", () => {
  it("returns null for null/garbage/empty objects", () => {
    expect(parseBranding(null)).toBeNull();
    expect(parseBranding(undefined)).toBeNull();
    expect(parseBranding("nonsense")).toBeNull();
    expect(parseBranding({ logoUrl: "not a url" })).toBeNull();
    expect(parseBranding({})).toBeNull();
  });

  it("returns the parsed config for valid input", () => {
    expect(parseBranding({ productName: "Acme" })).toEqual({ productName: "Acme" });
  });
});

describe("effectiveBranding", () => {
  const stored = { productName: "Acme" };

  it("renders stored branding for enterprise only (read-time gate)", () => {
    expect(effectiveBranding("enterprise", stored)).toEqual(stored);
    expect(effectiveBranding("standard", stored)).toBeNull();
    expect(effectiveBranding("starter", stored)).toBeNull();
    expect(effectiveBranding(null, stored)).toBeNull();
    expect(effectiveBranding(undefined, stored)).toBeNull();
  });

  it("returns null for enterprise tenants without stored branding", () => {
    expect(effectiveBranding("enterprise", null)).toBeNull();
  });
});
