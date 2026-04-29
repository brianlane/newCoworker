import { beforeEach, describe, expect, it, vi } from "vitest";

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

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/onboard/website-preview", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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
      jsonRequest({
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
      expect.objectContaining({ businessName: "Amy Laidlaw Real Estate", businessType: "real_estate" })
    );
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
