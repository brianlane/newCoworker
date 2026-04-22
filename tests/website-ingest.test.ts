import { describe, expect, it, vi } from "vitest";
import {
  assertSafeHostname,
  extractReadableText,
  extractSameOriginLinks,
  ingestWebsite,
  isPathAllowed,
  normalizeWebsiteUrl,
  parseRobotsDisallows
} from "@/lib/website-ingest";

describe("normalizeWebsiteUrl", () => {
  it("prepends https when scheme is missing", () => {
    expect(normalizeWebsiteUrl("example.com")).toBe("https://example.com/");
  });

  it("preserves explicit schemes but strips hash fragments", () => {
    expect(normalizeWebsiteUrl("http://example.com/path#section")).toBe("http://example.com/path");
  });

  it("rejects empty / non-http schemes", () => {
    expect(normalizeWebsiteUrl("")).toBeNull();
    expect(normalizeWebsiteUrl("ftp://example.com")).toBeNull();
    expect(normalizeWebsiteUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("assertSafeHostname", () => {
  it("rejects localhost / .internal regardless of DNS", async () => {
    await expect(assertSafeHostname("localhost")).rejects.toThrow("private_address");
    await expect(assertSafeHostname("foo.internal")).rejects.toThrow("private_address");
  });

  it("rejects bare IP literals so SSRF cannot bypass DNS check", async () => {
    await expect(assertSafeHostname("127.0.0.1")).rejects.toThrow("private_address");
    await expect(assertSafeHostname("::1")).rejects.toThrow("private_address");
  });

  it("maps lookup failure to dns_failure", async () => {
    const lookup = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertSafeHostname("does-not-exist.example", lookup)).rejects.toThrow("dns_failure");
  });

  it("rejects DNS answers that resolve into RFC1918 space", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(assertSafeHostname("intranet.example", lookup)).rejects.toThrow("private_address");
  });

  it("accepts public addresses", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(assertSafeHostname("example.com", lookup)).resolves.toBeUndefined();
  });
});

describe("parseRobotsDisallows + isPathAllowed", () => {
  it("prefers our UA group over the wildcard group", () => {
    const robots = [
      "User-agent: *",
      "Disallow: /private",
      "",
      "User-agent: newcoworker-bot",
      "Disallow: /only-ours"
    ].join("\n");
    const rules = parseRobotsDisallows(robots);
    expect(rules).toEqual(["/only-ours"]);
    expect(isPathAllowed("/", rules)).toBe(true);
    expect(isPathAllowed("/only-ours/x", rules)).toBe(false);
  });

  it("falls back to the wildcard group when no UA-specific group matches", () => {
    const robots = ["User-agent: *", "Disallow: /admin"].join("\n");
    const rules = parseRobotsDisallows(robots);
    expect(isPathAllowed("/admin/page", rules)).toBe(false);
    expect(isPathAllowed("/about", rules)).toBe(true);
  });

  it("treats empty Disallow as allow-all", () => {
    const rules = parseRobotsDisallows("User-agent: *\nDisallow:");
    expect(rules).toEqual([]);
    expect(isPathAllowed("/anything", rules)).toBe(true);
  });
});

describe("extractReadableText", () => {
  it("strips scripts, styles, and html entities", () => {
    const html = `
      <html><head><style>body{color:red}</style><script>alert(1)</script></head>
      <body><h1>Hi &amp; welcome</h1><p>Call us: 555&#8209;1212</p></body></html>
    `;
    const text = extractReadableText(html);
    expect(text).not.toMatch(/alert\(/);
    expect(text).not.toMatch(/color:red/);
    expect(text).toMatch(/Hi & welcome/);
    expect(text).toMatch(/Call us/);
  });
});

describe("extractSameOriginLinks", () => {
  it("keeps same-origin html-ish links and drops assets / off-domain / mailto", () => {
    const base = new URL("https://example.com/");
    const html = `
      <a href="/about">About</a>
      <a href="/pricing.html">Pricing</a>
      <a href="https://example.com/contact">Contact</a>
      <a href="https://other.example/">Other</a>
      <a href="mailto:hi@example.com">Mail</a>
      <a href="/logo.png">Logo</a>
    `;
    const links = extractSameOriginLinks(html, base);
    expect(links.sort()).toEqual(
      ["https://example.com/about", "https://example.com/pricing.html", "https://example.com/contact"].sort()
    );
  });
});

describe("ingestWebsite", () => {
  it("returns invalid_url for garbage input", async () => {
    const res = await ingestWebsite("not a url");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_url");
  });

  it("short-circuits when robots.txt blocks the homepage", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /\n", {
          status: 200,
          headers: { "content-type": "text/plain" }
        });
      }
      throw new Error("should not fetch non-robots after disallow");
    }) as unknown as typeof fetch;

    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("blocked_by_robots");
  });

  it("summarizes crawled content on the happy path", async () => {
    const html = `<html><body><h1>Sunrise Realty</h1><p>${"We help buyers. ".repeat(40)}</p></body></html>`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        return new Response("", { status: 404 });
      }
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nSunrise Realty helps buyers.");

    const res = await ingestWebsite("sunriserealty.com", {
      fetchImpl,
      lookup,
      summarize,
      businessName: "Sunrise Realty"
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.websiteMd).toMatch(/# website\.md/);
      expect(res.websiteMd).toMatch(/Source: https:\/\/sunriserealty\.com/);
      expect(res.websiteMd).toMatch(/Sunrise Realty helps buyers/);
      expect(res.pagesCrawled).toBeGreaterThanOrEqual(1);
    }
    expect(summarize).toHaveBeenCalledOnce();
    const prompt = summarize.mock.calls[0][0] as string;
    expect(prompt).toMatch(/Sunrise Realty/);
  });

  it("reports empty_content when the page has almost no readable text", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response("<html><body><script>x()</script></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/empty_content|fetch_failed/);
  });
});
