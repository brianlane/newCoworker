import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:dns so the "uses dns.lookup by default" test can deterministically
// resolve example.com without touching the network. Ingestion with explicit
// `lookup` options bypasses this mock entirely.
vi.mock("node:dns", () => ({
  promises: {
    lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }])
  }
}));

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

  it("rejects every reserved IPv4 range so SSRF can't hide behind a public DNS answer", async () => {
    // Each cases array item exercises a different branch in `isPrivateIpv4`:
    // 127 (loopback), 0.0.0.0/8 (current net), 169.254 (link-local),
    // 172.16/12, 192.168, multicast (224+), and malformed inputs.
    const reserved = [
      "127.0.0.1",
      "0.0.0.0",
      "169.254.169.254",
      "172.20.0.1",
      "192.168.1.1",
      "224.0.0.1",
      "not-an-ip",
      "300.300.300.300"
    ];
    for (const address of reserved) {
      const lookup = vi.fn().mockResolvedValue([{ address, family: 4 }]);
      await expect(assertSafeHostname("resolved.example", lookup)).rejects.toThrow("private_address");
    }
  });

  it("rejects reserved IPv6 forms (loopback + unspecified) when DNS returns them", async () => {
    for (const address of ["::1", "::"]) {
      const lookup = vi.fn().mockResolvedValue([{ address, family: 6 }]);
      await expect(assertSafeHostname("resolved6.example", lookup)).rejects.toThrow("private_address");
    }
  });

  it("rejects an empty DNS answer as dns_failure", async () => {
    const lookup = vi.fn().mockResolvedValue([]);
    await expect(assertSafeHostname("ghost.example", lookup)).rejects.toThrow("dns_failure");
  });

  it("accepts public addresses", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(assertSafeHostname("example.com", lookup)).resolves.toBeUndefined();
  });

  it("rejects link-local and ULA IPv6 answers", async () => {
    const fe80 = vi.fn().mockResolvedValue([{ address: "fe80::1", family: 6 }]);
    await expect(assertSafeHostname("v6.example", fe80)).rejects.toThrow("private_address");

    const ula = vi.fn().mockResolvedValue([{ address: "fd00::1", family: 6 }]);
    await expect(assertSafeHostname("ula.example", ula)).rejects.toThrow("private_address");
  });

  it("rejects IPv4-mapped IPv6 that points back into RFC1918", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "::ffff:10.0.0.1", family: 6 }]);
    await expect(assertSafeHostname("mapped.example", lookup)).rejects.toThrow("private_address");
  });

  it("accepts a public IPv6 address", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]);
    await expect(assertSafeHostname("v6-public.example", lookup)).resolves.toBeUndefined();
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

  it("merges consecutive User-agent lines into a single group", () => {
    // Hits the `current.agents.push(...)` continuation branch: two back-to-back
    // UA lines before any Disallow shares one group, so a Disallow under the
    // second UA applies to the first UA too.
    const robots = [
      "User-agent: newcoworker-bot",
      "User-agent: other-bot",
      "Disallow: /blocked"
    ].join("\n");
    const rules = parseRobotsDisallows(robots);
    expect(rules).toEqual(["/blocked"]);
  });

  it("ignores bogus lines that contain no colon", () => {
    // Non-field lines should short-circuit without poisoning the current
    // group. This keeps the parser resilient to weird robots.txt syntaxes.
    const robots = "# comment only\njust text here\nUser-agent: *\nDisallow: /x";
    const rules = parseRobotsDisallows(robots);
    expect(rules).toEqual(["/x"]);
  });

  it("skips Disallow lines that appear before any User-agent header", () => {
    // `Disallow` without an active group should be silently dropped. This
    // covers the `field === 'disallow' && current` short-circuit where
    // `current` is null because no UA has opened a group yet.
    const robots = ["Disallow: /orphan", "User-agent: *", "Disallow: /real"].join("\n");
    const rules = parseRobotsDisallows(robots);
    expect(rules).toEqual(["/real"]);
  });

  it("isPathAllowed treats explicitly-empty rules as no-op (defense when callers hand-build the array)", () => {
    // parseRobotsDisallows filters empty strings, but callers can pass a
    // hand-built list; the guard in `isPathAllowed` keeps those safe.
    expect(isPathAllowed("/anything", ["", "/admin"])).toBe(true);
    expect(isPathAllowed("/admin/x", ["", "/admin"])).toBe(false);
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

  // CodeQL js/double-escaping: `&amp;lt;` must NOT decode into `<`. Decoding
  // `&amp;` last preserves one literal `&` per source `&amp;`, which stops the
  // cascade from flipping structural HTML hidden in the crawled body.
  it("decodes &amp; last so &amp;lt; stays as &lt; instead of <", () => {
    const text = extractReadableText("<p>&amp;lt;tag&amp;gt;</p>");
    expect(text).toBe("&lt;tag&gt;");
    expect(text).not.toContain("<tag>");
  });

  it("leaves unknown numeric entities as spaces instead of crashing", () => {
    // NaN + out-of-range code points hit the fallback branch in the &#NN;
    // handler — both should become whitespace, not raw entity text.
    const text = extractReadableText("<p>x&#0;y&#99999999;z</p>");
    expect(text).toBe("x y z");
  });

  it("comment and block-level tag stripping still produces newline-separated output", () => {
    const text = extractReadableText(
      "<div>A<!-- hidden --></div><br/><section>B</section><li>C</li><noscript>D</noscript>"
    );
    expect(text.split("\n")).toEqual(["A", "B", "C"]);
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

  // CodeQL js/incomplete-url-scheme-check: enumerate every scheme we skip so
  // the lint stops firing and the audit trail matches DOM-XSS sanitizer
  // guidance, even though the origin check would already reject most.
  it("skips data:, vbscript:, tel:, and javascript: hrefs", () => {
    const base = new URL("https://example.com/");
    const html = [
      '<a href="javascript:alert(1)">js</a>',
      '<a href="JAVASCRIPT:alert(1)">js upper</a>',
      '<a href="DATA:text/html,<svg/onload=alert(1)>">data</a>',
      '<a href="vbscript:msgbox(1)">vb</a>',
      '<a href="tel:+15551212">tel</a>',
      '<a href="mailto:a@b.com">mail</a>',
      '<a href="#top">hash</a>',
      '<a href="/real">real</a>'
    ].join("");
    const links = extractSameOriginLinks(html, base);
    expect(links).toEqual(["https://example.com/real"]);
  });

  it("handles single-quoted and unquoted hrefs", () => {
    const base = new URL("https://example.com/");
    const html = ["<a href='/quoted'>q</a>", "<a href=/bare>u</a>"].join("");
    const links = extractSameOriginLinks(html, base);
    expect(links.sort()).toEqual(["https://example.com/bare", "https://example.com/quoted"].sort());
  });

  it("swallows hrefs that fail URL parsing rather than throwing", () => {
    const base = new URL("https://example.com/");
    // `http://%` triggers a WHATWG URL parse error, exercising the catch arm
    // that CodeQL otherwise complains about for untyped regex captures.
    const html = '<a href="http://%">broken</a><a href="/ok">ok</a>';
    const links = extractSameOriginLinks(html, base);
    expect(links).toEqual(["https://example.com/ok"]);
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

  it("returns dns_failure when DNS lookup fails", async () => {
    const lookup = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("dns_failure");
  });

  it("returns private_address when the initial hostname resolves into RFC1918", async () => {
    // Hits the `private_address` arm of the ternary in the outer catch block
    // of ingestWebsite — symmetric to the dns_failure test above, but through
    // `assertSafeHostname`'s IP-check path instead of the lookup-reject path.
    const lookup = vi.fn().mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const res = await ingestWebsite("https://intranet.example/", {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("private_address");
  });

  it("returns blocked_by_robots when the homepage path is disallowed by robots.txt", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /private", { status: 200 });
      }
      throw new Error(`should not fetch ${url}`);
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await ingestWebsite("https://example.com/private/page", {
      fetchImpl,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("blocked_by_robots");
  });

  it("returns summarizer_unavailable when the summarizer reports missing credentials", async () => {
    const html = `<html><body><h1>Realty</h1><p>${"We help buyers. ".repeat(40)}</p></body></html>`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => {
        throw new Error("summarizer_unavailable");
      }
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("summarizer_unavailable");
  });

  it("returns summarizer_failed with detail when the summarizer errors", async () => {
    const html = `<html><body><h1>Realty</h1><p>${"We help buyers. ".repeat(40)}</p></body></html>`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => {
        throw new Error("upstream_429");
      }
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("summarizer_failed");
      expect(res.detail).toBe("upstream_429");
    }
  });

  it("rejects non_html_content_type after a successful fetch", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response("binary", {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("fetch_failed");
  });

  // --- Manual redirect + SSRF-per-hop guardrails ---

  it("follows same-origin redirects and surfaces the final url", async () => {
    const html = `<html><body><h1>Hi</h1><p>${"We help. ".repeat(50)}</p></body></html>`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/") {
        return new Response(null, {
          status: 301,
          headers: { location: "/landing" }
        });
      }
      if (url === "https://example.com/landing") {
        return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.finalUrl).toBe("https://example.com/landing");
    // hostname re-validated on the redirect hop
    expect(lookup).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("blocks a redirect that points at a private IP via DNS rebind", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://intranet.example/" }
        });
      }
      throw new Error(`leaked redirect to ${url}`);
    }) as unknown as typeof fetch;
    // example.com → public, intranet.example → 10.0.0.5. Only the redirect
    // hop should fail the lookup allowlist.
    const lookup = vi.fn(async (host: string) => {
      if (host === "intranet.example") return [{ address: "10.0.0.5", family: 4 }];
      return [{ address: "93.184.216.34", family: 4 }];
    }) as never;
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("fetch_failed");
  });

  it("rejects a redirect without a Location header", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      // Non-empty body so `hopResponse.body.cancel()` runs — covers the
      // drain-before-redirect branch.
      return new Response("redirect body", { status: 301 });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("fetch_failed");
  });

  it("rejects a redirect whose Location header fails URL parsing", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      // `http://%` is a parse error in the WHATWG URL API, so the manual
      // redirect path must throw invalid_redirect_target rather than
      // attempting to fetch it.
      return new Response("drain", { status: 302, headers: { location: "http://%" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("fetch_failed");
  });

  it("rejects a redirect to a non-http scheme", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/") {
        return new Response(null, { status: 302, headers: { location: "ftp://example.com/file" } });
      }
      throw new Error(`leaked redirect to ${url}`);
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("fetch_failed");
  });

  it("gives up after MAX_REDIRECTS hops", async () => {
    let hops = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      hops++;
      return new Response(null, {
        status: 302,
        headers: { location: `/hop-${hops}` }
      });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("fetch_failed");
  });

  // --- Streaming byte cap ---

  it("aborts reads once chunks cross WEBSITE_INGEST_MAX_BYTES_PER_PAGE", async () => {
    // Build a stream that yields one chunk larger than the per-page cap. The
    // implementation must throw before buffering the whole payload.
    const oversize = new Uint8Array(2_000_000); // 2 MB > 1 MB cap
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(oversize);
        controller.close();
      }
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(stream, {
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
    if (!res.ok) expect(res.error).toBe("fetch_failed");
  });

  it("handles runtimes that expose no response.body by falling back to arrayBuffer", async () => {
    const html = `<html><body><h1>Realty</h1><p>${"We help buyers. ".repeat(40)}</p></body></html>`;
    const buildResponse = (body: string | null, status = 200) => {
      const base = new Response(body, {
        status,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
      // Force the streaming branch off to cover the fallback path.
      Object.defineProperty(base, "body", { value: null });
      return base;
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return buildResponse("", 404);
      return buildResponse(html);
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "## Summary\nok"
    });
    expect(res.ok).toBe(true);
  });

  it("trips payload_too_large on the arrayBuffer fallback too", async () => {
    const buildResponse = () => {
      const huge = new Uint8Array(2_000_000); // > 1 MB cap
      const r = new Response(huge, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
      Object.defineProperty(r, "body", { value: null });
      return r;
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        const r = new Response("", { status: 404 });
        Object.defineProperty(r, "body", { value: null });
        return r;
      }
      return buildResponse();
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("fetch_failed");
  });

  // --- Link queue expansion regardless of homepage text ---

  it("still expands the link queue when the homepage has no extractable text", async () => {
    const emptyHome =
      '<html><body><nav><a href="/about">About</a><a href="/services">Services</a></nav></body></html>';
    const rich = `<html><body><h1>About</h1><p>${"We help clients. ".repeat(30)}</p></body></html>`;
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      requested.push(url);
      if (url === "https://example.com/") {
        return new Response(emptyHome, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      return new Response(rich, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      maxPages: 3
    });
    expect(res.ok).toBe(true);
    // The homepage yielded no text but still expanded the queue, so we must
    // have requested at least one subpage in addition to the homepage.
    expect(requested.some((u) => u === "https://example.com/about" || u === "https://example.com/services")).toBe(true);
  });

  it("re-validates response.url hostname even when the runtime silently followed a redirect", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      // Simulate a runtime that ignored `redirect: "manual"` and returned a
      // response whose `.url` points at a different host. Our guard must run
      // `assertSafeHostname` on that final host before we read any bytes.
      const body = `<html><body><h1>x</h1><p>${"ok ".repeat(100)}</p></body></html>`;
      const response = new Response(body, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
      Object.defineProperty(response, "url", { value: "http://intranet.example/final" });
      return response;
    }) as unknown as typeof fetch;
    // example.com resolves public; intranet.example resolves into RFC1918.
    const lookup = vi.fn(async (host: string) => {
      if (host === "intranet.example") return [{ address: "10.0.0.5", family: 4 }];
      return [{ address: "93.184.216.34", family: 4 }];
    }) as never;
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("fetch_failed");
  });

  it("ignores non-SSRF errors during the final-host revalidation", async () => {
    const html = `<html><body><h1>Hi</h1><p>${"We help. ".repeat(40)}</p></body></html>`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      const response = new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
      // Malformed URL triggers the inner catch block, which should fall
      // through rather than throw (best-effort revalidation).
      Object.defineProperty(response, "url", { value: "not a url" });
      return response;
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");
    const res = await ingestWebsite("https://example.com/", { fetchImpl, lookup, summarize });
    expect(res.ok).toBe(true);
  });

  it("returns empty_content when combined text falls under 200 characters", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      // Short body produces <200 combined chars, hitting the final guard
      // before the summarizer even runs.
      return new Response("<html><body><p>Hi there friend.</p></body></html>", {
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
    if (!res.ok) expect(res.error).toBe("empty_content");
  });

  it("does not re-queue links that point back at a URL we've already visited", async () => {
    // Self-link to the homepage exercises the `visited.has(link)` branch in
    // the queue-expansion loop, which would otherwise silently fall through.
    const homepage =
      '<html><body><a href="https://example.com/">self</a><a href="/sub">sub</a><h1>home</h1><p>' +
      "Filler ".repeat(40) +
      "</p></body></html>";
    const sub = `<html><body><h1>sub</h1><p>${"sub ".repeat(40)}</p></body></html>`;
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/") {
        return new Response(homepage, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(sub, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", { fetchImpl, lookup, summarize, maxPages: 3 });
    expect(res.ok).toBe(true);
    // Homepage fetched once only; self-link must not re-queue.
    const homepageHits = requested.filter((u) => u === "https://example.com/").length;
    expect(homepageHits).toBe(1);
  });

  it("skips subpages that violate robots.txt disallow rules", async () => {
    const homepage =
      '<html><body><nav><a href="/allowed">ok</a><a href="/forbidden/page">nope</a></nav><p>' +
      "Filler ".repeat(40) +
      "</p></body></html>";
    const rich = `<html><body><h1>Allowed</h1><p>${"hello ".repeat(40)}</p></body></html>`;
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /forbidden", { status: 200 });
      }
      if (url === "https://example.com/") {
        return new Response(homepage, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(rich, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", { fetchImpl, lookup, summarize, maxPages: 4 });
    expect(res.ok).toBe(true);
    // `/forbidden/page` must NEVER have been fetched even though it was in
    // the homepage's link queue.
    expect(requested).not.toContain("https://example.com/forbidden/page");
  });

  it("stops growing the queue once queue.length + pages.length hits maxPages", async () => {
    // Build a homepage with many links; maxPages: 2 should cap queue growth
    // without ever reaching the richer pages.
    const nav = Array.from({ length: 10 }, (_, i) => `<a href="/p${i}">x</a>`).join("");
    const homepage = `<html><body>${nav}<h1>home</h1><p>${"filler ".repeat(40)}</p></body></html>`;
    const sub = `<html><body><h1>sub</h1><p>${"sub ".repeat(40)}</p></body></html>`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/") {
        return new Response(homepage, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(sub, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", { fetchImpl, lookup, summarize, maxPages: 2 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pagesCrawled).toBeLessThanOrEqual(2);
  });

  it("rejects responses whose content-type is absent or non-html-ish", async () => {
    // Build a Response whose headers.get('content-type') returns null so the
    // `?? ""` fallback runs, then the HTML regex fails and we bail with
    // non_html_content_type — which the outer crawler surfaces as fetch_failed.
    const makeHeaderlessResponse = (body: string) => {
      const response = new Response(body, { status: 200 });
      const headers = new Headers();
      Object.defineProperty(response, "headers", { value: headers });
      return response;
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return makeHeaderlessResponse("<html><body>hi</body></html>");
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("fetch_failed");
  });

  it("handles a summarizer that throws a non-Error value by using 'unknown' as detail", async () => {
    const html = `<html><body><h1>Realty</h1><p>${"We help buyers. ".repeat(40)}</p></body></html>`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => {
        throw "string throw";
      }
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("summarizer_failed");
      expect(res.detail).toBe("unknown");
    }
  });

  it("includes businessType in the summarization prompt when provided", async () => {
    const html = `<html><body><h1>Realty</h1><p>${"We help buyers. ".repeat(40)}</p></body></html>`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      businessName: "Acme",
      businessType: "real estate"
    });
    expect(res.ok).toBe(true);
    expect(summarize).toHaveBeenCalledOnce();
    expect(summarize.mock.calls[0][0]).toMatch(/Acme \(real estate\)/);
  });

  it("falls back to node:dns and global fetch when no fetchImpl/lookup is provided", async () => {
    // Stub global fetch so the real network isn't touched. The `node:dns`
    // module is mocked at the top of this file, so ingestion using defaults
    // will still resolve to the stubbed public IP.
    const html = `<html><body><h1>Realty</h1><p>${"We help. ".repeat(40)}</p></body></html>`;
    const globalFetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "## Summary\nok" } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("fetch", globalFetch);
    const OLD = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = "test-key";
    try {
      const res = await ingestWebsite("https://example.com/");
      expect(res.ok).toBe(true);
    } finally {
      process.env.GOOGLE_API_KEY = OLD;
      vi.unstubAllGlobals();
    }
  });

  it("accepts an anonymous-business prompt when businessName is not provided", async () => {
    const html = `<html><body><h1>Realty</h1><p>${"We help buyers. ".repeat(40)}</p></body></html>`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    await ingestWebsite("https://example.com/", { fetchImpl, lookup, summarize });
    expect(summarize.mock.calls[0][0]).toMatch(/a small business/);
  });

  it("clamps options.maxPages into the [1, 10] window", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(`<html><body><h1>Hi</h1><p>${"We help. ".repeat(40)}</p></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    // maxPages: 50 should clamp down to 10; maxPages: 0 should clamp up to 1.
    const high = await ingestWebsite("https://example.com/", { fetchImpl, lookup, summarize, maxPages: 50 });
    const low = await ingestWebsite("https://example.com/", { fetchImpl, lookup, summarize, maxPages: 0 });
    expect(high.ok).toBe(true);
    expect(low.ok).toBe(true);
  });
});

/**
 * Exercise the default Gemini summarizer by leaving `summarize` unset so
 * ingestWebsite reaches into `defaultGeminiSummarize`. We swap the global
 * `fetch` in/out to intercept the Gemini POST without leaving side effects.
 */
describe("defaultGeminiSummarize (via ingestWebsite)", () => {
  const OLD_ENV = process.env;
  const richHtml = `<html><body><h1>Realty</h1><p>${"We help buyers find homes. ".repeat(30)}</p></body></html>`;
  const publicLookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

  function pageFetchImpl() {
    return vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(richHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    process.env = { ...OLD_ENV };
  });
  afterEach(() => {
    process.env = OLD_ENV;
    vi.unstubAllGlobals();
  });

  it("fails with summarizer_unavailable when GOOGLE_API_KEY + GEMINI_API_KEY are both missing", async () => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl: pageFetchImpl(),
      lookup: publicLookup as never
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("summarizer_unavailable");
  });

  it("returns summary text when the Gemini endpoint responds 200", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    const globalFetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "## Summary\nclean" } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", globalFetch);

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl: pageFetchImpl(),
      lookup: publicLookup as never
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.websiteMd).toMatch(/clean/);
    expect(globalFetch).toHaveBeenCalledOnce();
  });

  it("surfaces gemini_http_<code> on a non-2xx Gemini response", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("rate limited body that should be truncated to 200 chars".repeat(10), {
          status: 429,
          headers: { "content-type": "text/plain" }
        })
      )
    );

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl: pageFetchImpl(),
      lookup: publicLookup as never
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("summarizer_failed");
      expect(res.detail).toMatch(/^gemini_http_429/);
    }
  });

  it("surfaces summarizer_empty when Gemini returns no content", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl: pageFetchImpl(),
      lookup: publicLookup as never
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toBe("summarizer_empty");
  });

  it("falls back to an empty detail string when response.text() itself rejects", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    // Build a Response-like object whose .text() rejects, exercising the
    // `.catch(() => "")` branch in defaultGeminiSummarize.
    const brokenResponse: Partial<Response> = {
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error("stream broken"))
    };
    vi.stubGlobal("fetch", vi.fn(async () => brokenResponse as Response));

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl: pageFetchImpl(),
      lookup: publicLookup as never
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("summarizer_failed");
      expect(res.detail).toMatch(/^gemini_http_500:/);
    }
  });
});
