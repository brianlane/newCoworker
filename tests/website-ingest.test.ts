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
  humanizeFetchError,
  ingestWebsite,
  ingestWebsiteFromHtml,
  isPathAllowed,
  looksLikeWafChallenge,
  normalizeWebsiteUrl,
  parseRobotsDisallows,
  parseSitemapLocs,
  WEBSITE_INGEST_DEEP_MAX_PAGES,
  WEBSITE_INGEST_MAX_BYTES_PER_PAGE,
  WEBSITE_INGEST_MAX_PASTED_HTML_CHARS,
  WEBSITE_INGEST_SITEMAP_MAX_CHILDREN
} from "@/lib/website-ingest";
import * as geminiGc from "@/lib/gemini-generate-content";
import * as aiSpendMeter from "@/lib/billing/ai-spend-meter";
import { logger } from "@/lib/logger";

type FetchArgs = Parameters<typeof fetch>;

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

describe("humanizeFetchError", () => {
  // Owners whose own site is fronted by Cloudflare with bot-fight-mode on
  // see HTTP 403 + `cf-mitigated: challenge` on every crawl. Before this
  // helper, the dashboard rendered the canned "Check the URL, SSL, or
  // firewall and retry" — which was actively misleading. These tests
  // pin the actionable copy.
  it("maps 403 to a CDN-blocking explanation that mentions Cloudflare and the paste-source fallback", () => {
    const msg = humanizeFetchError("status_403");
    expect(msg).toMatch(/HTTP 403/);
    expect(msg).toMatch(/Cloudflare|CDN|bot/i);
    expect(msg).toMatch(/View Page Source/i);
  });

  it("maps 401 the same way (auth-walled site behaves identically from the crawler's perspective)", () => {
    expect(humanizeFetchError("status_401")).toMatch(/HTTP 403\/401/);
  });

  it("maps 429 to a 'rate-limited, wait and retry' message", () => {
    expect(humanizeFetchError("status_429")).toMatch(/rate-limited/i);
  });

  it("maps any 5xx to a 'server error, try later' message and includes the actual status code", () => {
    expect(humanizeFetchError("status_503")).toMatch(/HTTP 503/);
    expect(humanizeFetchError("status_500")).toMatch(/server error/i);
  });

  it("maps other status_NNN responses to a generic 'verify the URL' message that still echoes the code", () => {
    const msg = humanizeFetchError("status_418");
    expect(msg).toMatch(/HTTP 418/);
    expect(msg).toMatch(/Verify the URL/i);
  });

  it("maps non_html_content_type to a 'use the canonical landing page' message (not just a raw enum)", () => {
    expect(humanizeFetchError("non_html_content_type")).toMatch(/canonical landing page|non-HTML/i);
  });

  it("maps redirect-loop messages to a 'use the final URL' message", () => {
    expect(humanizeFetchError("redirect_loop")).toMatch(/redirected too many times/i);
    expect(humanizeFetchError("too_many_redirects")).toMatch(/redirected too many times/i);
  });

  it("maps DNS / private-address failures to a 'check the URL' copy", () => {
    expect(humanizeFetchError("private_address")).toMatch(/resolve/i);
    expect(humanizeFetchError("dns_failure")).toMatch(/resolve/i);
  });

  it("falls back to a generic prefixed message when the underlying message is unrecognized", () => {
    // The raw message is preserved so support can still diagnose
    // oddball crawler errors from production logs without us having to
    // hand-extend the mapping for every transient failure.
    expect(humanizeFetchError("ECONNRESET")).toBe("Crawler error: ECONNRESET.");
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

  // CodeQL (js/bad-tag-filter): earlier regex `<\/script>` missed closing
  // tags with whitespace. Confirm the hardened regex strips `</script >`,
  // `</style\n>`, and `</noscript\t>` so inline JS/CSS cannot slip through.
  it("strips script/style/noscript tags with whitespace before the closing >", () => {
    const html =
      "<p>hi</p>" +
      "<script>alert('x')</script >" +
      "<style>body{color:red}</style\n>" +
      "<noscript>nope</noscript\t>" +
      "<p>bye</p>";
    const text = extractReadableText(html);
    expect(text).not.toMatch(/alert\(/);
    expect(text).not.toMatch(/color:red/);
    expect(text).not.toMatch(/nope/);
    expect(text).toContain("hi");
    expect(text).toContain("bye");
  });

  it("drops unterminated <script>/<style> openers so their bodies never leak", () => {
    const text = extractReadableText("<p>intro</p><script>evil()");
    expect(text).toBe("intro");
    const text2 = extractReadableText("<p>css</p><style>body{color:red}");
    expect(text2).toBe("css");
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

  it("ignoreRobots=true bypasses a default-deny robots.txt and still ingests", async () => {
    // The exact production case: a site (e.g. phoenixareasbestrealtor.com)
    // ships a default `User-agent: * / Disallow: /` block that locks out
    // every unknown crawler. With strict compliance the owner's own
    // assistant can never learn about their own business. The
    // owner-consented bypass (passed by /api/onboard/website-preview and
    // /api/onboard/website-ingest, both invoked with an URL the owner
    // explicitly typed in) skips robots and proceeds to crawl.
    const html = `<html><body><h1>Realty</h1><p>${"We help buyers. ".repeat(50)}</p></body></html>`;
    const rawFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        // Default-deny — would block under strict compliance.
        return new Response("User-agent: *\nDisallow: /\n", {
          status: 200,
          headers: { "content-type": "text/plain" }
        });
      }
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    const fetchImpl = rawFetch as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nRealty.");

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      ignoreRobots: true
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.websiteMd).toMatch(/Realty/);
      expect(res.pagesCrawled).toBeGreaterThanOrEqual(1);
    }
    // Bypass is total — robots.txt is never even fetched, saving the
    // round-trip and removing it as a possible failure mode.
    expect(
      rawFetch.mock.calls.some(([url]) => String(url).endsWith("/robots.txt"))
    ).toBe(false);
  });

  it("ignoreRobots does not weaken SSRF / private-IP / DNS-rebind defenses", async () => {
    // Bypass MUST only relax the robots layer — security guardrails still
    // apply. A redirect to a private IP must still be blocked even though
    // robots is being skipped.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://example.com/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://intranet.example/" }
        });
      }
      throw new Error(`leaked redirect to ${url}`);
    }) as unknown as typeof fetch;
    const lookup = vi.fn(async (host: string) => {
      if (host === "intranet.example") return [{ address: "10.0.0.5", family: 4 }];
      return [{ address: "93.184.216.34", family: 4 }];
    }) as never;

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused",
      ignoreRobots: true
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("fetch_failed");
  });

  it("readerFallback recovers content via Jina when the direct crawl is 403-blocked (Cloudflare)", async () => {
    // The production case: Cloudflare returns a 403 JS challenge to our
    // non-browser fetch, so the direct crawl yields zero pages. With the
    // reader fallback enabled we GET r.jina.ai/<url>, which returns clean
    // markdown from a server-side browser pool, and summarize that instead.
    const markdown = `# Realty\n\n${"We help buyers across Phoenix. ".repeat(20)}`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://r.jina.ai/")) {
        return new Response(markdown, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }
      // Everything on the origin (incl. robots not fetched due to ignoreRobots)
      // is blocked by the CDN.
      return new Response("blocked", {
        status: 403,
        headers: { "content-type": "text/html" }
      });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nRealty helps buyers.");

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      ignoreRobots: true,
      readerFallback: true
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.websiteMd).toMatch(/Realty helps buyers/);
      expect(res.pagesCrawled).toBe(1);
    }
    // The reader endpoint must have actually been hit with the (encoded) target URL.
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([u]) =>
        String(u) === `https://r.jina.ai/${encodeURIComponent("https://example.com/")}`
      )
    ).toBe(true);
    expect(summarize).toHaveBeenCalledOnce();
  });

  it("URL-encodes the target so query strings survive the Jina reader hop", async () => {
    const markdown = `# Listings\n\n${"We help buyers. ".repeat(20)}`;
    let readerUrl: string | undefined;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://r.jina.ai/")) {
        readerUrl = url;
        return new Response(markdown, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }
      return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const res = await ingestWebsite("https://example.com/search?q=homes&page=2", {
      fetchImpl,
      lookup,
      summarize: async () => "## Summary\nListings.",
      ignoreRobots: true,
      readerFallback: true
    });

    expect(res.ok).toBe(true);
    // The encoded target must carry the full query; decoding it back yields the
    // original URL (no dropped params).
    expect(readerUrl).toBe(
      `https://r.jina.ai/${encodeURIComponent("https://example.com/search?q=homes&page=2")}`
    );
    expect(decodeURIComponent(readerUrl!.slice("https://r.jina.ai/".length))).toBe(
      "https://example.com/search?q=homes&page=2"
    );
  });

  it("does NOT call the Jina reader when readerFallback is off (default)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("blocked", { status: 403, headers: { "content-type": "text/html" } })
    ) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused",
      ignoreRobots: true
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("fetch_failed");
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([u]) =>
        String(u).startsWith("https://r.jina.ai/")
      )
    ).toBe(false);
  });

  it("keeps the original fetch_failed error when the Jina reader also fails", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://r.jina.ai/")) {
        return new Response("nope", { status: 502, headers: { "content-type": "text/plain" } });
      }
      return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused",
      ignoreRobots: true,
      readerFallback: true
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("fetch_failed");
      // Homepage 403 detail is still surfaced for the owner.
      expect(res.detail).toMatch(/403/);
    }
  });

  it("sends an Authorization header to Jina when JINA_API_KEY is set", async () => {
    const prevKey = process.env.JINA_API_KEY;
    process.env.JINA_API_KEY = "jina-test-key";
    try {
      const markdown = `# Realty\n\n${"We help buyers. ".repeat(20)}`;
      let readerHeaders: Record<string, string> | undefined;
      const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        if (url.startsWith("https://r.jina.ai/")) {
          readerHeaders = init?.headers;
          return new Response(markdown, {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" }
          });
        }
        return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
      }) as unknown as typeof fetch;
      const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

      const res = await ingestWebsite("https://example.com/", {
        fetchImpl,
        lookup,
        summarize: async () => "## Summary\nRealty.",
        ignoreRobots: true,
        readerFallback: true
      });

      expect(res.ok).toBe(true);
      expect(readerHeaders?.authorization).toBe("Bearer jina-test-key");
    } finally {
      if (prevKey === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = prevKey;
    }
  });

  it("ignores an empty/whitespace-only Jina response and reports fetch_failed", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://r.jina.ai/")) {
        return new Response("   \n  ", {
          status: 200,
          headers: { "content-type": "text/plain" }
        });
      }
      return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused",
      ignoreRobots: true,
      readerFallback: true
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("fetch_failed");
  });

  it("rejects a Jina 200 whose body is a WAF challenge page and keeps the honest 403 detail", async () => {
    // The production false-success: Cloudflare blocks the direct crawl AND
    // serves Jina's browser pool the challenge page. Jina returns it with
    // HTTP 200, so before the looksLikeWafChallenge guard we summarized the
    // challenge copy into website.md and reported success.
    const challengeBody = [
      "Title: Just a moment...",
      "",
      "URL Source: https://example.com/",
      "",
      "Warning: Target URL returned error 403: Forbidden",
      "",
      "Markdown Content:",
      "Just a moment...",
      "Enable JavaScript and cookies to continue"
    ].join("\n");
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://r.jina.ai/")) {
        return new Response(challengeBody, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }
      return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn();

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      ignoreRobots: true,
      readerFallback: true
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("fetch_failed");
      // The owner sees the real story (403 + paste-source hint), not a
      // garbage summary of "Just a moment...".
      expect(res.detail).toMatch(/403/);
    }
    expect(summarize).not.toHaveBeenCalled();
  });

  it("tolerates a non-Error rejection from the Jina fetch", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://r.jina.ai/")) {
        // Reject with a non-Error value to exercise the String(err) branch.
        return Promise.reject("jina network blip");
      }
      return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused",
      ignoreRobots: true,
      readerFallback: true
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("fetch_failed");
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

  it("reports bytesDownloaded as true UTF-8 byte count, not UTF-16 code units", async () => {
    // Multi-byte payload: each "café" is 5 UTF-8 bytes but 4 JS string
    // characters. Before the fix `bytesDownloaded += body.length` under-
    // counted by 1 byte per occurrence. We serve ~200 occurrences so the gap
    // is unambiguous (>= 150 bytes).
    const sentence = `café ${"Service detail. ".repeat(40)}`;
    const html = `<html><body><h1>Heading</h1><p>${sentence.repeat(5)}</p></body></html>`;
    const expectedBytes = new TextEncoder().encode(html).byteLength;
    const expectedStringLen = html.length;
    expect(expectedBytes).toBeGreaterThan(expectedStringLen);

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nCafé services.");

    const res = await ingestWebsite("https://example.com/", { fetchImpl, lookup, summarize });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.bytesDownloaded).toBe(expectedBytes);
      expect(res.bytesDownloaded).toBeGreaterThan(expectedStringLen);
    }
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

  it("forwards the homepage HTTP status as `detail` when every page fails (CDN-blocked sites get an actionable message instead of canned copy)", async () => {
    // Real-world repro: phoenixareasbestrealtor.com fronts via Cloudflare
    // with bot mitigation enabled. Every fetch attempt returned 403 with
    // `cf-mitigated: challenge`, but the dashboard rendered the generic
    // "Check the URL, SSL, or firewall" copy. Owners had no idea their
    // own CDN was the blocker. With detail forwarding, the dashboard
    // shows "Your site blocked our crawler (HTTP 403/401)..." and points
    // them at the manual-paste fallback.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response("forbidden", { status: 403 });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("fetch_failed");
      expect(res.detail).toMatch(/HTTP 403/);
      expect(res.detail).toMatch(/Cloudflare|CDN|bot/i);
    }
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
    const oversize = new Uint8Array(WEBSITE_INGEST_MAX_BYTES_PER_PAGE + 1);
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
      const huge = new Uint8Array(WEBSITE_INGEST_MAX_BYTES_PER_PAGE + 1);
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
      // CodeQL (js/incomplete-url-substring-sanitization): compare the parsed
      // hostname exactly instead of `url.includes(...)` so spoofed URLs like
      // `https://attacker.com/?generativelanguage.googleapis.com` can't match.
      if (new URL(url).hostname === "generativelanguage.googleapis.com") {
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "## Summary\nok" }] } }] }),
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

  it(`clamps options.maxPages into the [1, ${WEBSITE_INGEST_DEEP_MAX_PAGES}] window`, async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(`<html><body><h1>Hi</h1><p>${"We help. ".repeat(40)}</p></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    // Above the deep ceiling clamps down; 0 clamps up to 1.
    const high = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      maxPages: WEBSITE_INGEST_DEEP_MAX_PAGES + 100
    });
    const low = await ingestWebsite("https://example.com/", { fetchImpl, lookup, summarize, maxPages: 0 });
    expect(high.ok).toBe(true);
    expect(low.ok).toBe(true);
  });

  // --- Deep crawl: BFS from subpages, concurrency, deadline, byte budget ---

  const richBody = (label: string, links: string[] = []) =>
    `<html><body>${links.map((l) => `<a href="${l}">x</a>`).join("")}<h1>${label}</h1><p>${`${label} detail. `.repeat(
      40
    )}</p></body></html>`;

  it("BFS-expands links from subpages, not just the homepage", async () => {
    // /b is only discoverable through /a — and /a itself is a textless nav
    // page (link hub). The old homepage-only expansion could never reach /b;
    // deep BFS must, and the textless hub must not count as a crawled page.
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/") {
        return new Response(richBody("home", ["/a"]), { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url === "https://example.com/a") {
        return new Response('<html><body><nav><a href="/b"></a></nav></body></html>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      return new Response(richBody("b"), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", { fetchImpl, lookup, summarize, maxPages: 3 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pagesCrawled).toBe(2); // home + /b; /a is a textless hub
    expect(requested).toContain("https://example.com/b");
  });

  it("keeps the crawl alive when a subpage fails (homepage detail stays clean)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/") {
        return new Response(richBody("home", ["/broken", "/ok"]), {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://example.com/broken") {
        return new Response("boom", { status: 500 });
      }
      return new Response(richBody("ok"), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", { fetchImpl, lookup, summarize, maxPages: 4 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pagesCrawled).toBe(2); // home + /ok, /broken skipped
  });

  it("fetches subpages in bounded concurrent waves (never more than 4 in flight)", async () => {
    let inFlight = 0;
    let peak = 0;
    const nav = Array.from({ length: 12 }, (_, i) => `/p${i}`);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/") {
        return new Response(richBody("home", nav), { status: 200, headers: { "content-type": "text/html" } });
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return new Response(richBody(url), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", { fetchImpl, lookup, summarize, maxPages: 13 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pagesCrawled).toBe(13);
    expect(peak).toBeGreaterThan(1); // waves actually run in parallel
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("stops crawling subpages once the crawl deadline has elapsed", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(richBody("home", ["/a", "/b"]), {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    // Deadline of 0 ms: the homepage (fetched before the wave loop) is kept,
    // but no subpage wave ever starts.
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      maxPages: 5,
      crawlDeadlineMs: 0
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pagesCrawled).toBe(1);
    expect(requested.filter((u) => !u.endsWith("robots.txt"))).toEqual(["https://example.com/"]);
  });

  it("stops crawling subpages once the cumulative byte budget is exhausted", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(richBody("home", ["/a", "/b"]), {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    // The homepage download alone (> 1 byte) exhausts the budget.
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      maxPages: 5,
      maxTotalBytes: 1
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pagesCrawled).toBe(1);
    expect(requested.filter((u) => !u.endsWith("robots.txt"))).toEqual(["https://example.com/"]);
  });

  // --- Sitemap discovery ---

  const urlset = (locs: string[]) =>
    `<?xml version="1.0"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`;
  const sitemapIndex = (locs: string[]) =>
    `<?xml version="1.0"?><sitemapindex>${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join("")}</sitemapindex>`;
  const xmlResponse = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "application/xml" } });

  it("seeds the crawl queue from sitemap.xml when sitemapDiscovery is on (deduping homepage links)", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/sitemap.xml") {
        // /a is ALSO linked from the homepage — the queue must dedupe it.
        return xmlResponse(urlset(["https://example.com/a", "https://example.com/deep-page"]));
      }
      if (url === "https://example.com/") {
        return new Response(richBody("home", ["/a"]), { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(richBody(url), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      maxPages: 10,
      sitemapDiscovery: true
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pagesCrawled).toBe(3); // home + /a + /deep-page
    // /deep-page is not linked anywhere — only the sitemap could surface it.
    expect(requested).toContain("https://example.com/deep-page");
    // Deduped: /a fetched exactly once despite appearing in links AND sitemap.
    expect(requested.filter((u) => u === "https://example.com/a")).toHaveLength(1);
  });

  it("follows one level of sitemap-index nesting, skipping off-origin/malformed children and stopping at the child cap", async () => {
    const requested: string[] = [];
    const children = [
      "https://example.com/pages-sitemap.xml",
      "https://evil.example/off-origin-sitemap.xml", // off-origin: skipped
      "http://%", // malformed: skipped
      "https://example.com/blog-sitemap.xml",
      "https://example.com/c3.xml",
      "https://example.com/c4.xml",
      "https://example.com/c5.xml",
      // Beyond WEBSITE_INGEST_SITEMAP_MAX_CHILDREN valid children: never fetched.
      "https://example.com/never-fetched-sitemap.xml"
    ];
    expect(children.filter((c) => c.startsWith("https://example.com/")).length).toBeGreaterThan(
      WEBSITE_INGEST_SITEMAP_MAX_CHILDREN
    );
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/sitemap.xml") return xmlResponse(sitemapIndex(children));
      if (url === "https://example.com/pages-sitemap.xml") {
        return xmlResponse(urlset(["https://example.com/about"]));
      }
      if (url === "https://example.com/blog-sitemap.xml") {
        return xmlResponse(urlset(["https://example.com/blog/post-1"]));
      }
      if (url.endsWith("-sitemap.xml") || /c\d\.xml$/.test(url)) {
        return xmlResponse(urlset([]));
      }
      return new Response(richBody(url), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      maxPages: 10,
      sitemapDiscovery: true
    });
    expect(res.ok).toBe(true);
    expect(requested).toContain("https://example.com/about");
    expect(requested).toContain("https://example.com/blog/post-1");
    expect(requested).not.toContain("https://evil.example/off-origin-sitemap.xml");
    expect(requested).not.toContain("https://example.com/never-fetched-sitemap.xml");
  });

  it("seeds sitemap URLs before homepage links so a nav-heavy homepage can't starve sitemap-only pages", async () => {
    // Bugbot finding: with homepage links seeded first, a homepage carrying
    // maxPages worth of nav links filled the whole fetch budget and
    // sitemap-only pages (blog posts etc.) never got queued.
    const requested: string[] = [];
    const navLinks = Array.from({ length: 10 }, (_, i) => `/nav-${i}`);
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/sitemap.xml") {
        return xmlResponse(
          urlset([
            "https://example.com/blog/deep-1",
            "https://example.com/blog/deep-2",
            "https://example.com/blog/deep-3"
          ])
        );
      }
      if (url === "https://example.com/") {
        return new Response(richBody("home", navLinks), {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      return new Response(richBody(url), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      maxPages: 4,
      sitemapDiscovery: true
    });
    expect(res.ok).toBe(true);
    // All three sitemap-only pages made it into the 4-fetch budget…
    expect(requested).toContain("https://example.com/blog/deep-1");
    expect(requested).toContain("https://example.com/blog/deep-2");
    expect(requested).toContain("https://example.com/blog/deep-3");
    // …which means no nav link could be fetched (budget = home + 3).
    expect(requested.some((u) => u.includes("/nav-"))).toBe(false);
  });

  it("stops collecting sitemap URLs at the page cap without fetching further child sitemaps", async () => {
    const requested: string[] = [];
    const many = Array.from({ length: 10 }, (_, i) => `https://example.com/page-${i}`);
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/sitemap.xml") {
        return xmlResponse(
          sitemapIndex(["https://example.com/big-sitemap.xml", "https://example.com/extra-sitemap.xml"])
        );
      }
      if (url === "https://example.com/big-sitemap.xml") return xmlResponse(urlset(many));
      return new Response(richBody(url), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      maxPages: 3,
      sitemapDiscovery: true
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pagesCrawled).toBeLessThanOrEqual(3);
    // The cap was hit inside big-sitemap; the second child must not be fetched.
    expect(requested).not.toContain("https://example.com/extra-sitemap.xml");
  });

  it("skips off-origin, asset, and duplicate URLs listed in a sitemap", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/sitemap.xml") {
        return xmlResponse(
          urlset([
            "https://evil.example/elsewhere",
            "https://example.com/logo.png",
            "https://example.com/real-page",
            "https://example.com/real-page", // duplicate
            "http://%" // unparseable
          ])
        );
      }
      return new Response(richBody(url), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      maxPages: 10,
      sitemapDiscovery: true
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pagesCrawled).toBe(2); // home + /real-page
    expect(requested).not.toContain("https://evil.example/elsewhere");
    expect(requested).not.toContain("https://example.com/logo.png");
    expect(requested.filter((u) => u === "https://example.com/real-page")).toHaveLength(1);
  });

  it("degrades silently when sitemap.xml is missing, HTML (soft-404), or a child errors", async () => {
    // Missing sitemap.
    const missing = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url.endsWith("/sitemap.xml")) return new Response("nope", { status: 404 });
      return new Response(richBody("home"), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");
    const resMissing = await ingestWebsite("https://example.com/", {
      fetchImpl: missing,
      lookup,
      summarize,
      sitemapDiscovery: true
    });
    expect(resMissing.ok).toBe(true);

    // Soft-404: sitemap URL answers with an HTML page — must not be parsed
    // as a sitemap (content-type gate rejects it).
    const soft404 = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url.endsWith("/sitemap.xml")) {
        return new Response("<html><body>not found</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      return new Response(richBody("home"), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const resSoft = await ingestWebsite("https://example.com/", {
      fetchImpl: soft404,
      lookup,
      summarize,
      sitemapDiscovery: true
    });
    expect(resSoft.ok).toBe(true);

    // Child sitemap errors: the index parses but its child 500s.
    const childError = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/sitemap.xml") {
        return xmlResponse(sitemapIndex(["https://example.com/broken-sitemap.xml"]));
      }
      if (url === "https://example.com/broken-sitemap.xml") return new Response("boom", { status: 500 });
      return new Response(richBody("home"), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const resChild = await ingestWebsite("https://example.com/", {
      fetchImpl: childError,
      lookup,
      summarize,
      sitemapDiscovery: true
    });
    expect(resChild.ok).toBe(true);
  });

  it("tolerates a non-Error rejection from the sitemap fetch", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url.endsWith("/sitemap.xml")) return Promise.reject("sitemap network blip");
      return new Response(richBody("home"), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");
    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      sitemapDiscovery: true
    });
    expect(res.ok).toBe(true);
  });

  it("does not fetch sitemap.xml when sitemapDiscovery is off (default)", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(richBody("home"), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", { fetchImpl, lookup, summarize });
    expect(res.ok).toBe(true);
    expect(requested.some((u) => u.endsWith("/sitemap.xml"))).toBe(false);
  });

  // --- Low-signal reader fallback (JS-rendered SPA shells) ---

  it("falls back to Jina when the crawl 'succeeds' but yields near-zero text (JS-rendered SPA shell)", async () => {
    // The production KYP Ads case: a Vite/React site serves an HTML shell
    // whose only readable text is the <title> (41 chars) and zero <a> links.
    // The crawl 'succeeds' with one near-empty page, so the old
    // pages.length === 0 gate never fired and the ingest died with
    // empty_content. The low-signal gate must route this through Jina.
    const shell =
      '<html><head><title>KYP Ads | Paid Ads That Drive Real Growth</title></head><body><div id="root"></div></body></html>';
    const markdown = `# KYP Ads\n\n${"We manage Meta, Google, and TikTok ads. ".repeat(20)}`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://r.jina.ai/")) {
        return new Response(markdown, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(shell, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nKYP Ads manages paid ads.");

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      readerFallback: true
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.websiteMd).toMatch(/KYP Ads manages paid ads/);
      // The shell page was REPLACED by the rendered markdown, not appended.
      expect(res.pagesCrawled).toBe(1);
    }
    // The summarizer saw the rendered content, not just the shell title.
    const prompt = summarize.mock.calls[0][0] as string;
    expect(prompt).toContain("We manage Meta, Google, and TikTok ads.");
  });

  it("keeps empty_content when the SPA-shell fallback also fails", async () => {
    const shell = "<html><head><title>Shell Title</title></head><body><div id=\"root\"></div></body></html>";
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://r.jina.ai/")) return new Response("nope", { status: 502 });
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(shell, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused",
      readerFallback: true
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("empty_content");
  });

  it("treats a multi-page titles-only crawl as low-signal even when the titles sum past the floor", async () => {
    // Bugbot finding: with a corpus-wide sum, a deep crawl over N SPA shell
    // pages (each contributing only its ~50-char <title>) can add up past
    // the 200-char floor and produce a titles-only garbage summary. Signal
    // must be judged on the richest single page.
    const shellFor = (label: string, links: string[] = []) =>
      `<html><head><title>${label} | Long Marketing Title Words Here</title></head><body>${links
        .map((l) => `<a href="${l}"></a>`)
        .join("")}<div id="root"></div></body></html>`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/") {
        return new Response(shellFor("Home", ["/p1", "/p2", "/p3", "/p4", "/p5"]), {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      return new Response(shellFor(url.slice(-2)), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn();

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      maxPages: 10
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("empty_content");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("surfaces the homepage CDN error detail even when low-signal sitemap subpages were fetched", async () => {
    // Bugbot finding: homepage 403 (actionable CDN/WAF story) + sitemap
    // subpages returning SPA shells made `pages` non-empty, so the ingest
    // reported a generic empty_content and hid the 403 detail the owner
    // needs to act on.
    const shell = "<html><head><title>Shell Title</title></head><body><div id=\"root\"></div></body></html>";
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === "https://example.com/sitemap.xml") {
        return xmlResponse(urlset(["https://example.com/app-page"]));
      }
      if (url === "https://example.com/") {
        return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
      }
      return new Response(shell, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused",
      maxPages: 5,
      sitemapDiscovery: true
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("fetch_failed");
      expect(res.detail).toMatch(/HTTP 403/);
    }
  });

  it("caps total fetch attempts at maxPages even when every page is textless (BFS can't run away)", async () => {
    // Bugbot finding: budgeting on pages-with-text let a site of textless,
    // link-rich pages keep fetching until the deadline/byte budget. Every
    // dequeued URL must count against the maxPages budget.
    let serial = 0;
    const fetched: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      fetched.push(url);
      // Each textless page links to two brand-new URLs — an infinite frontier.
      const a = `/n${(serial += 1)}`;
      const b = `/n${(serial += 1)}`;
      return new Response(`<html><body><a href="${a}"></a><a href="${b}"></a></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize: async () => "unused",
      maxPages: 5
    });
    // Nothing readable anywhere → fetch_failed, and crucially only 5 fetches.
    expect(res.ok).toBe(false);
    expect(fetched).toHaveLength(5);
  });

  it("does not call Jina when the crawl already produced a rich corpus", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(richBody("home"), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl,
      lookup,
      summarize,
      readerFallback: true
    });
    expect(res.ok).toBe(true);
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([u]) =>
        String(u).startsWith("https://r.jina.ai/")
      )
    ).toBe(false);
  });
});

describe("parseSitemapLocs", () => {
  it("extracts page URLs from a urlset", () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/</loc><priority>1.0</priority></url>
      <url><loc> https://example.com/about </loc></url>
    </urlset>`;
    const { pageUrls, childSitemaps } = parseSitemapLocs(xml);
    expect(pageUrls).toEqual(["https://example.com/", "https://example.com/about"]);
    expect(childSitemaps).toEqual([]);
  });

  it("extracts child sitemaps from a sitemapindex (Wix-style)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" generatedBy="WIX">
      <sitemap><loc>https://example.com/blog-posts-sitemap.xml</loc><lastmod>2026-07-10</lastmod></sitemap>
      <sitemap><loc>https://example.com/pages-sitemap.xml</loc></sitemap>
    </sitemapindex>`;
    const { pageUrls, childSitemaps } = parseSitemapLocs(xml);
    expect(pageUrls).toEqual([]);
    expect(childSitemaps).toEqual([
      "https://example.com/blog-posts-sitemap.xml",
      "https://example.com/pages-sitemap.xml"
    ]);
  });

  it("handles CDATA-wrapped locs and skips blocks without a loc", () => {
    const xml = `<urlset>
      <url><loc><![CDATA[https://example.com/cdata-page]]></loc></url>
      <url><changefreq>weekly</changefreq></url>
      <url><loc></loc></url>
    </urlset>`;
    const { pageUrls } = parseSitemapLocs(xml);
    expect(pageUrls).toEqual(["https://example.com/cdata-page"]);
  });

  it("returns nothing for non-sitemap XML", () => {
    const { pageUrls, childSitemaps } = parseSitemapLocs("<rss><channel><title>feed</title></channel></rss>");
    expect(pageUrls).toEqual([]);
    expect(childSitemaps).toEqual([]);
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

  function gcModelFromFetchCall(input: Request | string | URL): string {
    const urlObj = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    const matched = urlObj.pathname.match(/\/models\/(.+):generateContent$/);
    if (!matched?.[1]) {
      throw new Error(`expected :generateContent path, got ${urlObj.pathname}`);
    }
    return decodeURIComponent(matched[1]);
  }

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
      if (new URL(url).hostname === "generativelanguage.googleapis.com") {
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "## Summary\nclean" }] } }] }),
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

  it("falls back to the hardcoded Gemini model when GEMINI_ROWBOAT_MODEL and GEMINI_SUMMARY_MODEL are unset", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    delete process.env.GEMINI_ROWBOAT_MODEL;
    delete process.env.GEMINI_SUMMARY_MODEL;
    const seen: unknown[] = [];
    const globalFetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(url).hostname === "generativelanguage.googleapis.com") {
        seen.push(gcModelFromFetchCall(url));
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "## Summary\nok" }] } }] }),
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
    expect(seen[0]).toBe("gemini-3-flash-preview");
  });

  it("coerces legacy GEMINI_ROWBOAT_MODEL gemini-1.5-* to the supported default", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    process.env.GEMINI_ROWBOAT_MODEL = "gemini-1.5-flash";
    delete process.env.GEMINI_SUMMARY_MODEL;
    const seen: unknown[] = [];
    const globalFetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(url).hostname === "generativelanguage.googleapis.com") {
        seen.push(gcModelFromFetchCall(url));
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "## Summary\nok" }] } }] }),
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
    expect(seen[0]).toBe("gemini-3-flash-preview");
  });

  it("coerces legacy GEMINI_ROWBOAT_MODEL models/gemini-1.5-* to the supported default", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    process.env.GEMINI_ROWBOAT_MODEL = "models/gemini-1.5-flash";
    delete process.env.GEMINI_SUMMARY_MODEL;
    const seen: unknown[] = [];
    const globalFetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(url).hostname === "generativelanguage.googleapis.com") {
        seen.push(gcModelFromFetchCall(url));
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "## Summary\nok" }] } }] }),
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
    expect(seen[0]).toBe("gemini-3-flash-preview");
  });

  it("falls back to default when env is only a bare models/ prefix after strip", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    process.env.GEMINI_ROWBOAT_MODEL = "models/";
    delete process.env.GEMINI_SUMMARY_MODEL;
    const seen: unknown[] = [];
    const globalFetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(url).hostname === "generativelanguage.googleapis.com") {
        seen.push(gcModelFromFetchCall(url));
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "## Summary\nok" }] } }] }),
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
    expect(seen[0]).toBe("gemini-3-flash-preview");
  });

  it("prefers GEMINI_SUMMARY_MODEL over GEMINI_ROWBOAT_MODEL when both are set", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    process.env.GEMINI_SUMMARY_MODEL = "gemini-2.0-flash";
    process.env.GEMINI_ROWBOAT_MODEL = "gemini-3.1-flash";
    const seen: unknown[] = [];
    const globalFetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(url).hostname === "generativelanguage.googleapis.com") {
        seen.push(gcModelFromFetchCall(url));
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "## Summary\nok" }] } }] }),
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
    expect(seen[0]).toBe("gemini-2.0-flash");
  });

  it("meters summarizer spend into the shared AI budget when meterBusinessId is set", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    delete process.env.GEMINI_SUMMARY_MODEL;
    delete process.env.GEMINI_ROWBOAT_MODEL;
    const meterSpy = vi
      .spyOn(aiSpendMeter, "meterGeminiSpendForBusiness")
      .mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL) => {
        const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (new URL(urlStr).hostname !== "generativelanguage.googleapis.com") {
          throw new Error(`unexpected fetch: ${urlStr}`);
        }
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "## Summary\nmetered" }] } }],
            usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 300 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    try {
      const res = await ingestWebsite("https://example.com/", {
        fetchImpl: pageFetchImpl(),
        lookup: publicLookup as never,
        meterBusinessId: "biz-meter-1"
      });
      expect(res.ok).toBe(true);
      expect(meterSpy).toHaveBeenCalledOnce();
      expect(meterSpy.mock.calls[0][0]).toMatchObject({
        businessId: "biz-meter-1",
        model: "gemini-3-flash-preview",
        surface: "website_ingest",
        usage: { promptTokens: 2000, outputTokens: 300 }
      });
    } finally {
      meterSpy.mockRestore();
    }
  });

  it("meters a billed-but-empty summarizer reply when meterBusinessId is set", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    delete process.env.GEMINI_SUMMARY_MODEL;
    delete process.env.GEMINI_ROWBOAT_MODEL;
    const meterSpy = vi
      .spyOn(aiSpendMeter, "meterGeminiSpendForBusiness")
      .mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL) => {
        const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (new URL(urlStr).hostname !== "generativelanguage.googleapis.com") {
          throw new Error(`unexpected fetch: ${urlStr}`);
        }
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [] } }],
            usageMetadata: { promptTokenCount: 1500, thoughtsTokenCount: 1500 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    try {
      const res = await ingestWebsite("https://example.com/", {
        fetchImpl: pageFetchImpl(),
        lookup: publicLookup as never,
        meterBusinessId: "biz-meter-1"
      });
      expect(res.ok).toBe(false);
      expect(meterSpy).toHaveBeenCalledOnce();
      expect(meterSpy.mock.calls[0][0]).toMatchObject({
        businessId: "biz-meter-1",
        surface: "website_ingest",
        usage: { promptTokens: 1500, outputTokens: 1500 },
        outputChars: 0
      });
    } finally {
      meterSpy.mockRestore();
    }
  });

  it("emits an audit log when coercing a legacy Gemini model env id", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    process.env.GEMINI_ROWBOAT_MODEL = "gemini-pro";
    delete process.env.GEMINI_SUMMARY_MODEL;
    const spy = vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL) => {
        const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (new URL(urlStr).hostname === "generativelanguage.googleapis.com") {
          return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "## Summary\nlogged" }] } }] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        throw new Error(`unexpected fetch: ${urlStr}`);
      })
    );

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl: pageFetchImpl(),
      lookup: publicLookup as never
    });

    expect(res.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      "website-ingest: coercing legacy Gemini model id for summarizer",
      expect.objectContaining({ from: "gemini-pro", to: "gemini-3-flash-preview" })
    );
    spy.mockRestore();
  });

  it("retries with gemini-3-flash-preview when the configured summarizer model returns HTTP 404", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    process.env.GEMINI_SUMMARY_MODEL = "some-custom-unstable-model";
    delete process.env.GEMINI_ROWBOAT_MODEL;
    const models: string[] = [];
    const globalFetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const hostname = new URL(url).hostname;
      if (hostname !== "generativelanguage.googleapis.com") {
        throw new Error(`unexpected fetch: ${url}`);
      }
      models.push(gcModelFromFetchCall(url));
      if (models.length === 1) {
        return new Response("{}", { status: 404 });
      }
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "## Summary\nretried" }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", globalFetch);

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl: pageFetchImpl(),
      lookup: publicLookup as never
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.websiteMd).toMatch(/retried/);
    expect(models).toEqual(["some-custom-unstable-model", "gemini-3-flash-preview"]);
  });

  it("treats a non-Error rejection from Gemini before remapping fails as unknown ingest detail", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    delete process.env.GEMINI_SUMMARY_MODEL;
    delete process.env.GEMINI_ROWBOAT_MODEL;
    const spy = vi.spyOn(geminiGc, "geminiGenerateTextDetailed").mockRejectedValue("boom");
    try {
      const res = await ingestWebsite("https://example.com/", {
        fetchImpl: pageFetchImpl(),
        lookup: publicLookup as never
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.detail).toBe("unknown");
    } finally {
      spy.mockRestore();
    }
  });

  it("maps gemini_empty from the fallback request after HTTP 404 to summarizer_empty", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    process.env.GEMINI_SUMMARY_MODEL = "some-custom-unstable-model";
    delete process.env.GEMINI_ROWBOAT_MODEL;
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL) => {
        const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (new URL(urlStr).hostname !== "generativelanguage.googleapis.com") {
          throw new Error(`unexpected fetch: ${urlStr}`);
        }
        attempts += 1;
        if (attempts === 1) {
          return new Response("{}", { status: 404 });
        }
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "  \t" }] } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl: pageFetchImpl(),
      lookup: publicLookup as never
    });

    expect(attempts).toBe(2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toBe("summarizer_empty");
  });

  it("does not retry a second HTTP 404 when already using gemini-3-flash-preview", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    delete process.env.GEMINI_SUMMARY_MODEL;
    delete process.env.GEMINI_ROWBOAT_MODEL;
    const fetchMock = vi.fn(async (): Promise<Response> => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await ingestWebsite("https://example.com/", {
      fetchImpl: pageFetchImpl(),
      lookup: publicLookup as never
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("summarizer_failed");
      expect(res.detail).toMatch(/^gemini_http_404/);
    }
    const typedCalls = fetchMock.mock.calls as unknown as FetchArgs[];
    const googleHits = typedCalls.filter((call) => {
      const input = call[0];
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new URL(urlStr).hostname === "generativelanguage.googleapis.com";
    });
    expect(googleHits).toHaveLength(1);
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
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] } }] }), {
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

describe("looksLikeWafChallenge", () => {
  it("flags Jina's explicit target-error warning line", () => {
    expect(
      looksLikeWafChallenge("Title: Some Site\n\nWarning: Target URL returned error 403: Forbidden\n\nbody")
    ).toBe(true);
  });

  it("flags well-known challenge-page titles regardless of error warnings", () => {
    expect(looksLikeWafChallenge("Title: Just a moment...\n\nMarkdown Content:\nhi")).toBe(true);
    expect(looksLikeWafChallenge("Title: Attention Required! | Cloudflare\n\nbody")).toBe(true);
    expect(looksLikeWafChallenge("Title: Access denied\n\nbody")).toBe(true);
  });

  it("flags challenge body copy when no metadata lines are present", () => {
    expect(looksLikeWafChallenge("Please Enable JavaScript and cookies to continue viewing")).toBe(true);
    expect(looksLikeWafChallenge("Checking your browser before accessing example.com")).toBe(true);
  });

  it("does not flag a normal business page that merely mentions security topics", () => {
    expect(
      looksLikeWafChallenge(
        "Title: Acme Locksmiths\n\nMarkdown Content:\nWe install access control and security checks for offices."
      )
    ).toBe(false);
  });

  it("only inspects the head of the body (a deep mention cannot false-positive)", () => {
    const deep = `Title: Acme Realty\n\n${"We help buyers find homes. ".repeat(100)}\nWarning: Target URL returned error 403`;
    expect(looksLikeWafChallenge(deep)).toBe(false);
  });
});

describe("ingestWebsiteFromHtml", () => {
  const richHtml = `<html><head><title>Realty</title></head><body><h1>Phoenix Realty</h1><p>${"We help buyers and sellers across the valley. ".repeat(20)}</p></body></html>`;

  it("summarizes pasted page source through the same pipeline (no fetches at all)", async () => {
    const summarize = vi.fn().mockResolvedValue("## Summary\nPhoenix Realty helps buyers.");
    const res = await ingestWebsiteFromHtml("https://example.com/", richHtml, { summarize });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.websiteMd).toMatch(/^# website\.md\nSource: https:\/\/example\.com\//);
      expect(res.websiteMd).toMatch(/Phoenix Realty helps buyers/);
      expect(res.pagesCrawled).toBe(1);
      expect(res.finalUrl).toBe("https://example.com/");
      expect(res.bytesDownloaded).toBe(Buffer.byteLength(richHtml, "utf8"));
    }
    // The summarizer received extracted TEXT, not raw markup.
    const prompt = summarize.mock.calls[0][0] as string;
    expect(prompt).toContain("Phoenix Realty");
    expect(prompt).not.toContain("<html>");
  });

  it("normalizes a scheme-less URL for the Source header", async () => {
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");
    const res = await ingestWebsiteFromHtml("example.com", richHtml, { summarize });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.websiteMd).toContain("Source: https://example.com/");
  });

  it("rejects garbage URLs with invalid_url", async () => {
    const res = await ingestWebsiteFromHtml("not a url", richHtml, {
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_url");
  });

  it("returns empty_content when the pasted markup carries too little text", async () => {
    const res = await ingestWebsiteFromHtml("https://example.com/", "<html><body>hi</body></html>", {
      summarize: async () => "unused"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("empty_content");
  });

  it("clips oversized pasted HTML to the hard cap before extraction", async () => {
    const summarize = vi.fn().mockResolvedValue("## Summary\nok");
    const oversized =
      `<p>${"We sell things to nice people. ".repeat(50)}</p>` +
      "x".repeat(WEBSITE_INGEST_MAX_PASTED_HTML_CHARS);
    const res = await ingestWebsiteFromHtml("https://example.com/", oversized, { summarize });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // bytesDownloaded reflects the CLIPPED size, proving the cap applied.
      expect(res.bytesDownloaded).toBe(WEBSITE_INGEST_MAX_PASTED_HTML_CHARS);
    }
  });

  it("maps summarizer failures the same way the crawl path does", async () => {
    const unavailable = await ingestWebsiteFromHtml("https://example.com/", richHtml, {
      summarize: async () => {
        throw new Error("summarizer_unavailable");
      }
    });
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) expect(unavailable.error).toBe("summarizer_unavailable");

    const failed = await ingestWebsiteFromHtml("https://example.com/", richHtml, {
      summarize: async () => {
        throw new Error("gemini_http_500:boom");
      }
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toBe("summarizer_failed");
      expect(failed.detail).toBe("gemini_http_500:boom");
    }
  });

  it("maps a non-Error summarizer throw to detail 'unknown'", async () => {
    const res = await ingestWebsiteFromHtml("https://example.com/", richHtml, {
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

  it("uses defaultGeminiSummarize when no summarizer is injected (summarizer_unavailable without keys)", async () => {
    const prevGoogle = process.env.GOOGLE_API_KEY;
    const prevGemini = process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const res = await ingestWebsiteFromHtml("https://example.com/", richHtml);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("summarizer_unavailable");
    } finally {
      if (prevGoogle === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = prevGoogle;
      if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGemini;
    }
  });
});
