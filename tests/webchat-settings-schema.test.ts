import { describe, expect, it } from "vitest";
import {
  MAX_ALLOWED_ORIGINS,
  normalizeAllowedOrigins,
  normalizeOrigin,
  originAllowed,
  parseWidgetTheme,
  widgetThemeSchema
} from "@/lib/webchat/settings-schema";

describe("widgetThemeSchema / parseWidgetTheme", () => {
  it("accepts valid themes", () => {
    const theme = {
      accentColor: "#2563eb",
      greeting: "Hi there!",
      agentDisplayName: "Acme assistant"
    };
    expect(widgetThemeSchema.parse(theme)).toEqual(theme);
    expect(parseWidgetTheme(theme)).toEqual(theme);
  });

  it("rejects bad accent colors and unknown keys", () => {
    expect(widgetThemeSchema.safeParse({ accentColor: "blue" }).success).toBe(false);
    expect(widgetThemeSchema.safeParse({ accentColor: "#fff" }).success).toBe(false);
    expect(widgetThemeSchema.safeParse({ nope: true }).success).toBe(false);
  });

  it("parseWidgetTheme returns null for null/undefined/invalid/empty", () => {
    expect(parseWidgetTheme(null)).toBeNull();
    expect(parseWidgetTheme(undefined)).toBeNull();
    expect(parseWidgetTheme("garbage")).toBeNull();
    expect(parseWidgetTheme({ accentColor: "red" })).toBeNull();
    expect(parseWidgetTheme({})).toBeNull();
  });
});

describe("normalizeOrigin", () => {
  it("normalizes case, trailing slashes, and paths down to the origin", () => {
    expect(normalizeOrigin("HTTPS://Example.COM/")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com/some/page?q=1")).toBe("https://example.com");
    expect(normalizeOrigin("  https://example.com  ")).toBe("https://example.com");
  });

  it("assumes https for bare hostnames and preserves explicit http + ports", () => {
    expect(normalizeOrigin("example.com")).toBe("https://example.com");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeOrigin("example.com:8443")).toBe("https://example.com:8443");
  });

  it("rejects empties, non-http(s) schemes, and unparseable input", () => {
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin("   ")).toBeNull();
    expect(normalizeOrigin("ftp://example.com")).toBeNull();
    expect(normalizeOrigin("javascript://alert")).toBeNull();
    expect(normalizeOrigin("https://not a url")).toBeNull();
    expect(normalizeOrigin("https://example.com:99999")).toBeNull();
  });
});

describe("normalizeAllowedOrigins", () => {
  it("normalizes, skips blanks, and dedupes", () => {
    expect(
      normalizeAllowedOrigins([
        "https://Example.com/",
        "example.com",
        "",
        "  ",
        "https://other.com"
      ])
    ).toEqual(["https://example.com", "https://other.com"]);
  });

  it("throws on an invalid entry, naming it", () => {
    expect(() => normalizeAllowedOrigins(["ftp://x.com"])).toThrow(/ftp:\/\/x\.com/);
  });

  it("caps the list length", () => {
    const many = Array.from({ length: MAX_ALLOWED_ORIGINS + 1 }, (_, i) => `https://s${i}.com`);
    expect(() => normalizeAllowedOrigins(many)).toThrow(/At most/);
  });
});

describe("originAllowed", () => {
  const allowed = ["https://example.com", "http://localhost:3000"];

  it("allows anything when the list is empty", () => {
    expect(originAllowed(null, [])).toBe(true);
    expect(originAllowed("https://anywhere.com", [])).toBe(true);
  });

  it("requires a parseable origin when the list is non-empty", () => {
    expect(originAllowed(null, allowed)).toBe(false);
    expect(originAllowed("", allowed)).toBe(false);
    expect(originAllowed("not a url", allowed)).toBe(false);
  });

  it("matches exact scheme + host + port", () => {
    expect(originAllowed("https://example.com", allowed)).toBe(true);
    expect(originAllowed("https://EXAMPLE.com/", allowed)).toBe(true);
    expect(originAllowed("http://localhost:3000", allowed)).toBe(true);
    expect(originAllowed("http://example.com", allowed)).toBe(false); // scheme mismatch
    expect(originAllowed("https://example.com:8443", allowed)).toBe(false); // port mismatch
    expect(originAllowed("https://evil.com", allowed)).toBe(false);
    expect(originAllowed("https://sub.example.com", allowed)).toBe(false); // no wildcard subdomains
  });

  it("treats www. and bare hosts as the same site (both directions)", () => {
    expect(originAllowed("https://www.example.com", allowed)).toBe(true);
    expect(originAllowed("https://example.com", ["https://www.example.com"])).toBe(true);
  });

  it("skips invalid entries in the stored list instead of throwing", () => {
    expect(originAllowed("https://example.com", ["ftp://junk", "https://example.com"])).toBe(true);
    expect(originAllowed("https://example.com", ["ftp://junk"])).toBe(false);
  });
});
