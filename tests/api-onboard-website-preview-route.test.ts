import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/website-ingest", () => ({
  ingestWebsite: vi.fn(),
  normalizeWebsiteUrl: vi.fn()
}));
vi.mock("@/lib/rate-limit", async () => {
  // Stub `rateLimit` per-test, but keep the real
  // `rateLimitIdentifierFromRequest` so the assertion that
  // `x-forwarded-for` flows into the rate-limit key actually
  // exercises the production header-parsing code path.
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return {
    ...actual,
    rateLimit: vi.fn()
  };
});
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/onboard/website-preview/route";
import { ingestWebsite, normalizeWebsiteUrl } from "@/lib/website-ingest";
import { rateLimit } from "@/lib/rate-limit";

const TRUSTED_APP_URL = "https://app.test";

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/onboard/website-preview", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

/**
 * Default browser-style request headers — same-origin Origin so the
 * route's owner-consent gate accepts the request (the production
 * happy path). Negative tests omit/override `origin` to exercise the
 * untrusted path.
 */
function browserRequest(body: unknown, extraHeaders: Record<string, string> = {}): Request {
  return jsonRequest(body, { origin: TRUSTED_APP_URL, ...extraHeaders });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The owner-consent gate compares request `Origin`/`Referer` against
  // `process.env.NEXT_PUBLIC_APP_URL`. Without this stub the gate
  // would fail closed (no trusted host configured) and every test
  // would land in the untrusted-fallback branch.
  vi.stubEnv("NEXT_PUBLIC_APP_URL", TRUSTED_APP_URL);
  vi.mocked(rateLimit).mockReturnValue({
    success: true,
    limit: 6,
    remaining: 5,
    reset: Date.now() + 60_000
  } as never);
  vi.mocked(normalizeWebsiteUrl).mockImplementation((raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      return new URL(withScheme).toString();
    } catch {
      return null;
    }
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/onboard/website-preview", () => {
  it("returns the website markdown on a successful crawl", async () => {
    vi.mocked(ingestWebsite).mockResolvedValue({
      ok: true,
      websiteMd: "# Phoenix Realty\n- Buy and sell homes in Phoenix metro.",
      pagesCrawled: 4,
      bytesDownloaded: 18_432,
      finalUrl: "https://www.phoenixareasbestrealtor.com/"
    });

    const res = await POST(
      browserRequest({
        websiteUrl: "phoenixareasbestrealtor.com",
        businessName: "Amy Laidlaw Real Estate",
        businessType: "real_estate"
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.ok).toBe(true);
    expect(body.data.websiteMd).toContain("Phoenix Realty");
    expect(body.data.finalUrl).toBe("https://www.phoenixareasbestrealtor.com/");
    expect(ingestWebsite).toHaveBeenCalledWith(
      "https://phoenixareasbestrealtor.com/",
      expect.objectContaining({
        businessName: "Amy Laidlaw Real Estate",
        businessType: "real_estate",
        // Owner-consented bypass: same-origin Origin → request came
        // from a browser tab on our questionnaire UI → the user just
        // typed in their own site's URL → bypass robots so default-deny
        // sites (real production case: phoenixareasbestrealtor.com)
        // don't break the owner's own onboarding.
        ignoreRobots: true
      })
    );
  });

  describe("owner-consent gate (P1: prevent abuse as a robots-bypassing crawler proxy)", () => {
    // The route is unauth'd by design (no business exists at Step 1→2),
    // so the robots bypass MUST be conditional on a same-origin signal
    // from a browser tab on our own UI. Otherwise any internet caller
    // could use the endpoint to crawl + summarize sites whose robots
    // disallow them — turning the route into a free crawler proxy with
    // only a 6/min/IP rate limit as mitigation.

    it("forwards ignoreRobots=true when Origin matches NEXT_PUBLIC_APP_URL", async () => {
      vi.mocked(ingestWebsite).mockResolvedValue({
        ok: true,
        websiteMd: "x",
        pagesCrawled: 1,
        bytesDownloaded: 1,
        finalUrl: "https://example.com/"
      });
      await POST(jsonRequest({ websiteUrl: "https://example.com" }, { origin: TRUSTED_APP_URL }));
      expect(ingestWebsite).toHaveBeenCalledWith(
        "https://example.com/",
        expect.objectContaining({ ignoreRobots: true })
      );
    });

    it("accepts a same-origin Referer when Origin is not set", async () => {
      // Some browser contexts (notably old `Referer-Policy: no-referrer`
      // disabling, or fetches that strip Origin) only send Referer.
      // Both headers identify the same caller, so either matching the
      // trusted host should consent the bypass.
      vi.mocked(ingestWebsite).mockResolvedValue({
        ok: true,
        websiteMd: "x",
        pagesCrawled: 1,
        bytesDownloaded: 1,
        finalUrl: "https://example.com/"
      });
      await POST(
        jsonRequest({ websiteUrl: "https://example.com" }, { referer: `${TRUSTED_APP_URL}/onboard/questionnaire` })
      );
      expect(ingestWebsite).toHaveBeenCalledWith(
        "https://example.com/",
        expect.objectContaining({ ignoreRobots: true })
      );
    });

    it("falls back to strict robots compliance when no Origin/Referer is sent (curl/scripts)", async () => {
      vi.mocked(ingestWebsite).mockResolvedValue({
        ok: true,
        websiteMd: "x",
        pagesCrawled: 1,
        bytesDownloaded: 1,
        finalUrl: "https://example.com/"
      });
      await POST(jsonRequest({ websiteUrl: "https://example.com" }));
      expect(ingestWebsite).toHaveBeenCalledWith(
        "https://example.com/",
        expect.objectContaining({ ignoreRobots: false })
      );
    });

    it("falls back to strict robots compliance when Origin is cross-origin", async () => {
      // A malicious site embedding a fetch to /api/onboard/website-preview
      // would carry its own Origin, not ours. Browsers set Origin
      // unforgeably; this is the primary CSRF-style abuse case.
      vi.mocked(ingestWebsite).mockResolvedValue({
        ok: true,
        websiteMd: "x",
        pagesCrawled: 1,
        bytesDownloaded: 1,
        finalUrl: "https://example.com/"
      });
      await POST(jsonRequest({ websiteUrl: "https://example.com" }, { origin: "https://attacker.example" }));
      expect(ingestWebsite).toHaveBeenCalledWith(
        "https://example.com/",
        expect.objectContaining({ ignoreRobots: false })
      );
    });

    it("falls back to strict robots compliance when Origin is malformed", async () => {
      // Defensive: a bogus Origin shouldn't get the benefit of the
      // doubt. Treat malformed values identically to "no Origin set".
      vi.mocked(ingestWebsite).mockResolvedValue({
        ok: true,
        websiteMd: "x",
        pagesCrawled: 1,
        bytesDownloaded: 1,
        finalUrl: "https://example.com/"
      });
      await POST(jsonRequest({ websiteUrl: "https://example.com" }, { origin: "not a url" }));
      expect(ingestWebsite).toHaveBeenCalledWith(
        "https://example.com/",
        expect.objectContaining({ ignoreRobots: false })
      );
    });

    it("fails closed when NEXT_PUBLIC_APP_URL is unconfigured (no trusted host to compare against)", async () => {
      vi.unstubAllEnvs();
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
      vi.mocked(ingestWebsite).mockResolvedValue({
        ok: true,
        websiteMd: "x",
        pagesCrawled: 1,
        bytesDownloaded: 1,
        finalUrl: "https://example.com/"
      });
      await POST(jsonRequest({ websiteUrl: "https://example.com" }, { origin: TRUSTED_APP_URL }));
      expect(ingestWebsite).toHaveBeenCalledWith(
        "https://example.com/",
        expect.objectContaining({ ignoreRobots: false })
      );
    });
  });

  it("returns ok:false (200) when ingest fails so the chat client can degrade gracefully", async () => {
    // Crawl failures are not 500s — the URL was syntactically valid, we
    // just couldn't pull useful content. The chat client uses this to
    // fall back to the "we can see the URL but not the content" prompt.
    vi.mocked(ingestWebsite).mockResolvedValue({
      ok: false,
      error: "fetch_failed",
      detail: "Connection reset"
    });

    const res = await POST(jsonRequest({ websiteUrl: "https://offline.example.com" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.ok).toBe(false);
    expect(body.data.error).toBe("fetch_failed");
    expect(body.data.detail).toBe("Connection reset");
  });

  it("rejects an invalid URL with 400", async () => {
    vi.mocked(normalizeWebsiteUrl).mockReturnValue(null);
    const res = await POST(jsonRequest({ websiteUrl: "not-a-url" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(ingestWebsite).not.toHaveBeenCalled();
  });

  it("rejects an empty body with 400 (zod)", async () => {
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(400);
    expect(ingestWebsite).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-IP rate limit is exhausted", async () => {
    vi.mocked(rateLimit).mockReturnValue({
      success: false,
      limit: 6,
      remaining: 0,
      reset: Date.now() + 60_000
    } as never);

    const res = await POST(jsonRequest({ websiteUrl: "https://example.com" }));
    expect(res.status).toBe(429);
    expect(ingestWebsite).not.toHaveBeenCalled();
  });

  it("derives the rate-limit identifier from x-forwarded-for", async () => {
    vi.mocked(ingestWebsite).mockResolvedValue({
      ok: true,
      websiteMd: "x",
      pagesCrawled: 1,
      bytesDownloaded: 100,
      finalUrl: "https://example.com/"
    });
    await POST(
      jsonRequest({ websiteUrl: "https://example.com" }, { "x-forwarded-for": "203.0.113.4, 10.0.0.1" })
    );
    expect(rateLimit).toHaveBeenCalledWith(
      "website-preview:203.0.113.4",
      expect.objectContaining({ maxRequests: 6 })
    );
  });
});
