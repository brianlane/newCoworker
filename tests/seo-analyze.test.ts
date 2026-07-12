import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import {
  SEO_MAX_BYTES,
  SEO_MAX_REDIRECTS,
  SEO_SCORE_WEIGHTS,
  analyzeWebsiteSeo,
  extractSeoSignals,
  industryKeywordsFor,
  overallSeoScore,
  parseAiRecommendations,
  readBodyBounded,
  ruleBasedSuggestions,
  scoreSeoSignals,
  type SeoSignals
} from "@/lib/seo/analyze";

const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];
const PRIVATE_LOOKUP = async () => [{ address: "192.168.0.10", family: 4 }];

const GOOD_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Desert Plumbing — Phoenix Plumber You Can Trust</title>
  <meta name="description" content="Family-owned Phoenix plumber. Drain cleaning, pipe repair, water heaters. Same-day service across the valley.">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
  <h1>Phoenix's friendly plumbing team</h1>
  <p>${"We handle drain cleaning, pipes, and water heaters fast. ".repeat(40)}</p>
  <p>Call (602) 555-0147 or visit us at 123 Cactus Rd, Suite 4.</p>
  <img src="/a.jpg" alt="Our truck"><img src="/b.jpg" alt="The crew">
  <a href="/services">Services</a><a href="/about">About</a><a href="/contact">Contact</a>
  <a href="/reviews">Reviews</a><a href="/book">Book</a>
</body>
</html>`;

type FakeResponse = {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
};

function response(status: number, body = "", headers: Record<string, string> = {}): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body
  };
}

function fetchSequence(responses: FakeResponse[]) {
  let i = 0;
  const calls: string[] = [];
  const impl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return res as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("industryKeywordsFor", () => {
  it("matches loose business types and returns [] for unknown/empty", () => {
    expect(industryKeywordsFor("Plumbing & drains")).toContain("plumber");
    expect(industryKeywordsFor("HVAC contractor")).toContain("air conditioning");
    expect(industryKeywordsFor("quantum consulting")).toEqual([]);
    expect(industryKeywordsFor(null)).toEqual([]);
    expect(industryKeywordsFor("  ")).toEqual([]);
  });

  it("does not cross-match substrings (student ≠ dentist, repair ≠ air, carpet ≠ car)", () => {
    expect(industryKeywordsFor("student tutoring")).toEqual([]);
    expect(industryKeywordsFor("appliance repair")).toEqual([]);
    expect(industryKeywordsFor("carpet installation")).toEqual([]);
    expect(industryKeywordsFor("dental office")).toContain("dentist");
    expect(industryKeywordsFor("car detailing")).toContain("auto repair");
  });
});

describe("readBodyBounded", () => {
  function streamOf(chunks: string[], cancelError?: Error) {
    const encoder = new TextEncoder();
    let i = 0;
    return {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined },
        cancel: async () => {
          if (cancelError) throw cancelError;
        }
      })
    };
  }

  it("streams up to the byte cap and cancels the remainder", async () => {
    const big = "x".repeat(600_000);
    const res = { body: streamOf([big, big, big]) } as unknown as Response;
    const text = await readBodyBounded(res);
    expect(text).toHaveLength(SEO_MAX_BYTES);
  });

  it("caps on RAW bytes, so multibyte content cannot stretch the budget", async () => {
    // "é" is 2 bytes UTF-8: 600k chars = 1.2MB — over the cap in one chunk,
    // so the second chunk must never be read.
    const twoByte = "é".repeat(600_000);
    let reads = 0;
    const encoder = new TextEncoder();
    const res = {
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return reads === 1
              ? { done: false, value: encoder.encode(twoByte) }
              : { done: false, value: encoder.encode("never") };
          },
          cancel: async () => {}
        })
      }
    } as unknown as Response;
    const text = await readBodyBounded(res);
    expect(reads).toBe(1);
    expect(text).not.toContain("never");
  });

  it("reads a small streamed body fully and tolerates a rejecting cancel", async () => {
    const res = {
      body: streamOf(["<html>", "hi", "</html>"], new Error("already closed"))
    } as unknown as Response;
    expect(await readBodyBounded(res)).toBe("<html>hi</html>");
  });

  it("falls back to text() for streamless responses", async () => {
    const res = { body: null, text: async () => "plain" } as unknown as Response;
    expect(await readBodyBounded(res)).toBe("plain");
  });
});

describe("extractSeoSignals + scoreSeoSignals", () => {
  it("reads a healthy page's signals", () => {
    const signals = extractSeoSignals(GOOD_HTML, "https://desertplumbing.example.com/", [
      "plumber",
      "drain cleaning"
    ]);
    expect(signals).toMatchObject({
      https: true,
      title: "Desert Plumbing — Phoenix Plumber You Can Trust",
      h1Count: 1,
      imageCount: 2,
      imagesWithAlt: 2,
      hasViewport: true,
      hasLangAttribute: true,
      hasPhone: true,
      hasAddressHint: true,
      keywordHits: ["plumber", "drain cleaning"]
    });
    expect(signals.metaDescription).toMatch(/Family-owned/);
    expect(signals.wordCount).toBeGreaterThan(300);
    expect(signals.sameOriginLinks).toBe(5);

    const breakdown = scoreSeoSignals(signals);
    expect(breakdown.content).toBe(100);
    expect(breakdown.localSeo).toBe(100);
    expect(breakdown.mobile).toBe(100);
    expect(breakdown.images).toBe(100);
    expect(breakdown.linking).toBe(100);
    expect(overallSeoScore(breakdown)).toBeGreaterThan(80);
  });

  it("scores a bare page near zero and supports the description-after-content attribute order", () => {
    const bare = extractSeoSignals("<html><body>hi</body></html>", "http://bare.example.com/", []);
    expect(bare.https).toBe(false);
    expect(bare.title).toBeNull();
    const breakdown = scoreSeoSignals(bare);
    expect(breakdown.title).toBe(0);
    expect(breakdown.description).toBe(0);
    expect(breakdown.mobile).toBe(0);
    // No images at all = nothing to fix on the images axis.
    expect(breakdown.images).toBe(100);
    expect(overallSeoScore(breakdown)).toBeLessThan(30);

    const flipped = extractSeoSignals(
      '<html><head><meta content="Great local shop with plenty of description text here." name="description"></head><body></body></html>',
      "https://x.example.com/",
      []
    );
    expect(flipped.metaDescription).toMatch(/Great local shop/);
  });

  it("grades edge lengths and multiple h1s", () => {
    const shortTitle = scoreSeoSignals(
      extractSeoSignals("<title>Hi</title>", "https://x.example.com/", [])
    );
    expect(shortTitle.title).toBe(70); // exists but out of range

    const multiH1 = scoreSeoSignals(
      extractSeoSignals("<h1>a</h1><h1>b</h1>", "https://x.example.com/", [])
    );
    expect(multiH1.technical).toBe(50 + 10); // https + multi-h1 penalty band

    const shortDesc = scoreSeoSignals(
      extractSeoSignals(
        '<meta name="description" content="Too short.">',
        "https://x.example.com/",
        []
      )
    );
    expect(shortDesc.description).toBe(70); // exists but outside the length band
  });
});

describe("ruleBasedSuggestions", () => {
  function signals(overrides: Partial<SeoSignals> = {}): SeoSignals {
    return {
      https: true,
      title: "A well-sized page title for a local shop",
      metaDescription: "A description comfortably inside the recommended length band for snippets.",
      h1Count: 1,
      imageCount: 2,
      imagesWithAlt: 2,
      wordCount: 500,
      hasViewport: true,
      hasLangAttribute: true,
      sameOriginLinks: 6,
      hasPhone: true,
      hasAddressHint: true,
      keywordHits: ["plumber"],
      ...overrides
    };
  }

  it("returns nothing for a healthy page", () => {
    expect(ruleBasedSuggestions(signals())).toEqual([]);
  });

  it("flags every weak signal with a targeted fix", () => {
    const out = ruleBasedSuggestions(
      signals({
        title: null,
        metaDescription: null,
        hasPhone: false,
        hasAddressHint: false,
        keywordHits: [],
        wordCount: 50,
        hasViewport: false,
        https: false,
        imageCount: 3,
        imagesWithAlt: 1,
        h1Count: 0
      })
    );
    // 10 fixes: every axis fires once (the title length advice is mutually
    // exclusive with the missing-title advice).
    expect(out).toHaveLength(10);
    expect(out.join(" ")).toMatch(/<title>/);
    expect(out.join(" ")).toMatch(/one <h1>/);
  });

  it("differentiates the oversized-title and extra-h1 advice", () => {
    const long = ruleBasedSuggestions(signals({ title: "x".repeat(80) }));
    expect(long[0]).toMatch(/20–65/);
    const extraH1 = ruleBasedSuggestions(signals({ h1Count: 3 }));
    expect(extraH1[0]).toMatch(/demote the extras/);
  });
});

describe("parseAiRecommendations", () => {
  it("strips bullets/numbering, drops fragments, caps at 5", () => {
    const raw = [
      "- Add your service area to the title tag",
      "2) Publish a dedicated drain-cleaning page",
      "• Ask happy customers for Google reviews",
      "ok",
      "* Compress your hero image for faster loads",
      "1. Add schema.org LocalBusiness markup",
      "- A sixth suggestion that should be cut off by the cap"
    ].join("\n");
    const parsed = parseAiRecommendations(raw);
    expect(parsed).toHaveLength(5);
    expect(parsed[0]).toBe("Add your service area to the title tag");
    expect(parsed).not.toContain("ok");
  });
});

describe("analyzeWebsiteSeo", () => {
  it("audits a reachable site end-to-end, with AI advice layered on", async () => {
    const { impl } = fetchSequence([response(200, GOOD_HTML)]);
    const generate = vi.fn(async () => "- Do the thing that matters most\n- Then the next thing");
    const result = await analyzeWebsiteSeo("desertplumbing.example.com", {
      fetchImpl: impl,
      lookup: PUBLIC_LOOKUP,
      generate,
      businessType: "plumbing",
      now: new Date("2026-07-04T12:00:00Z")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.url).toBe("https://desertplumbing.example.com/");
    expect(result.report.analyzedAt).toBe("2026-07-04T12:00:00.000Z");
    expect(result.report.overall).toBeGreaterThan(80);
    expect(result.report.aiRecommendations).toEqual([
      "Do the thing that matters most",
      "Then the next thing"
    ]);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("uses global fetch when none is injected and reports 'none' issues to the model", async () => {
    const { impl } = fetchSequence([response(200, GOOD_HTML)]);
    vi.stubGlobal("fetch", impl);
    try {
      const prompts: string[] = [];
      const result = await analyzeWebsiteSeo("https://desertplumbing.example.com", {
        lookup: PUBLIC_LOOKUP,
        businessType: "plumbing",
        generate: async (prompt) => {
          prompts.push(prompt);
          return "- Keep doing what you are doing";
        }
      });
      expect(result.ok).toBe(true);
      // The healthy fixture has zero rule-based issues → the prompt says so.
      expect(prompts[0]).toContain("Detected issues: none");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the deterministic report when the model fails (Error and non-Error)", async () => {
    for (const thrown of [new Error("model down"), "string failure"]) {
      const { impl } = fetchSequence([response(200, GOOD_HTML)]);
      const result = await analyzeWebsiteSeo("https://x.example.com", {
        fetchImpl: impl,
        lookup: PUBLIC_LOOKUP,
        generate: vi.fn(async () => {
          throw thrown;
        })
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.report.aiRecommendations).toEqual([]);
    }
  });

  it("follows revalidated redirects (draining their bodies) and reports the final URL", async () => {
    let redirectBodyCancelled = false;
    const redirect = {
      ...response(301, "", { location: "https://www.x.example.com/" }),
      body: {
        cancel: async () => {
          redirectBodyCancelled = true;
        }
      }
    } as unknown as FakeResponse;
    const { impl, calls } = fetchSequence([redirect, response(200, GOOD_HTML)]);
    const result = await analyzeWebsiteSeo("https://x.example.com", {
      fetchImpl: impl,
      lookup: PUBLIC_LOOKUP
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.url).toBe("https://www.x.example.com/");
    expect(calls).toHaveLength(2);
    expect(redirectBodyCancelled).toBe(true);
  });

  it("tolerates a redirect body whose cancel rejects", async () => {
    const redirect = {
      ...response(302, "", { location: "https://www.x.example.com/" }),
      body: {
        cancel: async () => {
          throw new Error("already consumed");
        }
      }
    } as unknown as FakeResponse;
    const { impl } = fetchSequence([redirect, response(200, GOOD_HTML)]);
    const result = await analyzeWebsiteSeo("https://x.example.com", {
      fetchImpl: impl,
      lookup: PUBLIC_LOOKUP
    });
    expect(result.ok).toBe(true);
  });

  it("re-validates the landed URL when the runtime auto-followed a redirect", async () => {
    // Same public host → accepted, and the landed URL becomes the report URL.
    const followedOk = {
      ...response(200, GOOD_HTML),
      url: "https://www.x.example.com/home"
    } as unknown as FakeResponse;
    const okResult = await analyzeWebsiteSeo("https://x.example.com", {
      fetchImpl: fetchSequence([followedOk]).impl,
      lookup: PUBLIC_LOOKUP
    });
    expect(okResult.ok).toBe(true);
    if (okResult.ok) expect(okResult.report.url).toBe("https://www.x.example.com/home");

    // Landed on a host that never passed the allowlist → refused unread.
    const lookupByHost = async (hostname: string) =>
      hostname === "x.example.com"
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "10.0.0.5", family: 4 }];
    const followedPrivate = {
      ...response(200, GOOD_HTML),
      url: "https://internal.example.com/"
    } as unknown as FakeResponse;
    const badResult = await analyzeWebsiteSeo("https://x.example.com", {
      fetchImpl: fetchSequence([followedPrivate]).impl,
      lookup: lookupByHost
    });
    expect(badResult).toMatchObject({ ok: false, error: "private_address" });

    // A DNS outage on the LANDED host is a fetch problem, not a
    // "not publicly reachable" verdict (same mapping as the hop check).
    const lookupDnsFail = async (hostname: string) => {
      if (hostname === "x.example.com") return [{ address: "93.184.216.34", family: 4 }];
      throw new Error("boom");
    };
    const followedDnsFail = {
      ...response(200, GOOD_HTML),
      url: "https://nxdomain.example.com/"
    } as unknown as FakeResponse;
    const dnsResult = await analyzeWebsiteSeo("https://x.example.com", {
      fetchImpl: fetchSequence([followedDnsFail]).impl,
      lookup: lookupDnsFail as never
    });
    expect(dnsResult).toMatchObject({
      ok: false,
      error: "fetch_failed",
      detail: "dns_failure"
    });
  });

  it("refuses invalid URLs, private hosts, dns failures, and redirect abuse", async () => {
    expect(await analyzeWebsiteSeo("not a url at all", {})).toEqual({
      ok: false,
      error: "invalid_url"
    });

    const { impl } = fetchSequence([response(200, GOOD_HTML)]);
    expect(
      (await analyzeWebsiteSeo("https://internal.example.com", {
        fetchImpl: impl,
        lookup: PRIVATE_LOOKUP
      })) as { error: string }
    ).toMatchObject({ ok: false, error: "private_address" });

    const dnsFail = async () => {
      throw new Error("boom");
    };
    expect(
      (await analyzeWebsiteSeo("https://nxdomain.example.com", {
        fetchImpl: impl,
        lookup: dnsFail as never
      })) as { error: string }
    ).toMatchObject({ ok: false, error: "fetch_failed", detail: "dns_failure" });

    const loop = fetchSequence([response(301, "", { location: "https://x.example.com/loop" })]);
    const loopResult = await analyzeWebsiteSeo("https://x.example.com", {
      fetchImpl: loop.impl,
      lookup: PUBLIC_LOOKUP
    });
    expect(loopResult).toMatchObject({ ok: false, error: "fetch_failed" });
    expect(loop.calls).toHaveLength(SEO_MAX_REDIRECTS + 1);

    const noLocation = fetchSequence([response(302)]);
    expect(
      await analyzeWebsiteSeo("https://x.example.com", {
        fetchImpl: noLocation.impl,
        lookup: PUBLIC_LOOKUP
      })
    ).toMatchObject({ ok: false, error: "fetch_failed" });

    // A redirect onto a non-web scheme must die before any further hop.
    const fileScheme = fetchSequence([response(302, "", { location: "file:///etc/passwd" })]);
    expect(
      await analyzeWebsiteSeo("https://x.example.com", {
        fetchImpl: fileScheme.impl,
        lookup: PUBLIC_LOOKUP
      })
    ).toMatchObject({ ok: false, error: "fetch_failed", detail: "non-http redirect" });
    expect(fileScheme.calls).toHaveLength(1);

    // A malformed Location header fails structured, not thrown.
    const badLocation = fetchSequence([response(302, "", { location: "https://[oops" })]);
    expect(
      await analyzeWebsiteSeo("https://x.example.com", {
        fetchImpl: badLocation.impl,
        lookup: PUBLIC_LOOKUP
      })
    ).toMatchObject({ ok: false, error: "fetch_failed", detail: "malformed redirect location" });
  });

  it("aborts a hung homepage fetch at the timeout", async () => {
    vi.useFakeTimers();
    try {
      const hung = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      ) as unknown as typeof fetch;
      const pending = analyzeWebsiteSeo("https://x.example.com", {
        fetchImpl: hung,
        lookup: PUBLIC_LOOKUP
      });
      const assertion = expect(pending).resolves.toMatchObject({
        ok: false,
        error: "fetch_failed"
      });
      await vi.advanceTimersByTimeAsync(11_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails structured when the body read itself dies (Error and non-Error)", async () => {
    for (const thrown of [new Error("aborted mid-body"), "stream reset"]) {
      const res = {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () => {
              throw thrown;
            },
            cancel: async () => {}
          })
        }
      } as unknown as Response;
      const impl = vi.fn(async () => res) as unknown as typeof fetch;
      expect(
        await analyzeWebsiteSeo("https://x.example.com", {
          fetchImpl: impl,
          lookup: PUBLIC_LOOKUP
        })
      ).toMatchObject({
        ok: false,
        error: "fetch_failed",
        detail: thrown instanceof Error ? thrown.message : String(thrown)
      });
    }
  });

  it("maps HTTP errors, network throws, and empty bodies", async () => {
    const { impl } = fetchSequence([response(503, "down")]);
    expect(
      await analyzeWebsiteSeo("https://x.example.com", { fetchImpl: impl, lookup: PUBLIC_LOOKUP })
    ).toMatchObject({ ok: false, error: "fetch_failed", detail: "status 503" });

    const throwing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(
      await analyzeWebsiteSeo("https://x.example.com", {
        fetchImpl: throwing,
        lookup: PUBLIC_LOOKUP
      })
    ).toMatchObject({ ok: false, error: "fetch_failed" });

    const nonError = vi.fn(async () => {
      throw "socket reset";
    }) as unknown as typeof fetch;
    expect(
      await analyzeWebsiteSeo("https://x.example.com", {
        fetchImpl: nonError,
        lookup: PUBLIC_LOOKUP
      })
    ).toMatchObject({ ok: false, error: "fetch_failed", detail: "socket reset" });

    const empty = fetchSequence([response(200, "   ")]);
    expect(
      await analyzeWebsiteSeo("https://x.example.com", {
        fetchImpl: empty.impl,
        lookup: PUBLIC_LOOKUP
      })
    ).toEqual({ ok: false, error: "empty_page" });
  });

  it("weights sum to 100 (rubric sanity)", () => {
    const total = Object.values(SEO_SCORE_WEIGHTS).reduce((s, w) => s + w, 0);
    expect(total).toBe(100);
  });
});
