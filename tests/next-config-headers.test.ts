/**
 * The security header set in next.config.ts is CASA evidence, so it gets a
 * test rather than only a comment. The Access-Control-Allow-Origin entry in
 * particular exists to override a wildcard the hosting platform adds to
 * statically served assets; if it silently disappears, the wildcard comes
 * back and the finding reopens.
 */
import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";
import { SITE_URL } from "@/lib/marketing/site-url";

type HeaderEntry = { key: string; value: string };
type HeaderRule = { source: string; headers: HeaderEntry[] };

async function rules(): Promise<HeaderRule[]> {
  const headers = nextConfig.headers;
  if (!headers) throw new Error("next.config.ts defines no headers()");
  return (await headers()) as HeaderRule[];
}

function ruleFor(all: HeaderRule[], predicate: (source: string) => boolean): HeaderRule {
  const found = all.find((rule) => predicate(rule.source));
  if (!found) throw new Error("no matching header rule");
  return found;
}

function valueOf(rule: HeaderRule, key: string): string | undefined {
  return rule.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
}

describe("next.config security headers", () => {
  it("never sends a wildcard Access-Control-Allow-Origin", async () => {
    for (const rule of await rules()) {
      expect(valueOf(rule, "Access-Control-Allow-Origin")).not.toBe("*");
    }
  });

  it("pins Access-Control-Allow-Origin to our own origin on the baseline rule", async () => {
    const baseline = ruleFor(await rules(), (source) => source !== "/widget/frame");
    expect(valueOf(baseline, "Access-Control-Allow-Origin")).toBe(SITE_URL);
    // Guard the intent, not just the value: a relative or empty origin would
    // be accepted by the assertion above only if SITE_URL itself broke.
    expect(SITE_URL.startsWith("https://")).toBe(true);
  });

  it("keeps the widget frame carve-out free of a framing block", async () => {
    // The widget is the one surface that must be embeddable on customer sites,
    // so it must not inherit X-Frame-Options or frame-ancestors 'none'.
    const widget = ruleFor(await rules(), (source) => source === "/widget/frame");
    expect(valueOf(widget, "X-Frame-Options")).toBeUndefined();
    expect(valueOf(widget, "Content-Security-Policy")).toBeUndefined();
    expect(valueOf(widget, "X-Robots-Tag")).toBe("noindex");
  });

  it("keeps HSTS on both rules, since the CDN does not add it", async () => {
    for (const rule of await rules()) {
      expect(valueOf(rule, "Strict-Transport-Security")).toContain("max-age=");
    }
  });
});
