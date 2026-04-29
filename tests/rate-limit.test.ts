import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, RATE_LIMITS, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";

describe("rate-limit", () => {
  beforeEach(() => {
    // Reset module state by calling with an expired entry to trigger cleanup
  });

  it("allows first request and returns correct remaining count", () => {
    const result = rateLimit("test-first-request", { interval: 60_000, maxRequests: 5 });
    expect(result.success).toBe(true);
    expect(result.limit).toBe(5);
    expect(result.remaining).toBe(4);
    expect(result.reset).toBeGreaterThan(Date.now() - 1000);
  });

  it("increments count on subsequent requests", () => {
    const config = { interval: 60_000, maxRequests: 3 };
    const id = "test-increment";
    rateLimit(id, config);
    const second = rateLimit(id, config);
    expect(second.remaining).toBe(1);
    const third = rateLimit(id, config);
    expect(third.remaining).toBe(0);
    expect(third.success).toBe(true);
  });

  it("rejects when rate limit exceeded", () => {
    const config = { interval: 60_000, maxRequests: 2 };
    const id = "test-exceed";
    rateLimit(id, config);
    rateLimit(id, config);
    const third = rateLimit(id, config);
    expect(third.success).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it("resets after interval expires", async () => {
    const config = { interval: 50, maxRequests: 1 };
    const id = "test-expire";
    rateLimit(id, config);
    const rejected = rateLimit(id, config);
    expect(rejected.success).toBe(false);

    await new Promise((r) => setTimeout(r, 60));
    const afterExpiry = rateLimit(id, config);
    expect(afterExpiry.success).toBe(true);
    expect(afterExpiry.remaining).toBe(0);
  });

  it("cleans up expired entries opportunistically", async () => {
    const config = { interval: 10, maxRequests: 100 };
    for (let i = 0; i < 15; i++) {
      rateLimit(`cleanup-${i}`, config);
    }
    await new Promise((r) => setTimeout(r, 20));
    const result = rateLimit("cleanup-trigger", config);
    expect(result.success).toBe(true);
  });

  it("exports predefined RATE_LIMITS", () => {
    expect(RATE_LIMITS.AUTH.maxRequests).toBe(5);
    expect(RATE_LIMITS.API.maxRequests).toBe(60);
    expect(RATE_LIMITS.WEBHOOK.maxRequests).toBe(100);
  });
});

describe("rateLimitIdentifierFromRequest", () => {
  function makeRequest(headers: Record<string, string>): Request {
    return new Request("https://example.test/", { headers });
  }

  it("uses the first entry of x-forwarded-for", () => {
    const id = rateLimitIdentifierFromRequest(
      makeRequest({ "x-forwarded-for": "203.0.113.4, 10.0.0.1, 10.0.0.2" })
    );
    expect(id).toBe("203.0.113.4");
  });

  it("trims whitespace around the forwarded IP", () => {
    const id = rateLimitIdentifierFromRequest(
      makeRequest({ "x-forwarded-for": "  198.51.100.7  , 10.0.0.1" })
    );
    expect(id).toBe("198.51.100.7");
  });

  it("falls back to x-real-ip when x-forwarded-for is empty", () => {
    const id = rateLimitIdentifierFromRequest(
      makeRequest({ "x-forwarded-for": "", "x-real-ip": "192.0.2.5" })
    );
    expect(id).toBe("192.0.2.5");
  });

  it("falls back to x-real-ip when x-forwarded-for is whitespace only", () => {
    const id = rateLimitIdentifierFromRequest(
      makeRequest({ "x-forwarded-for": "   ", "x-real-ip": "192.0.2.5" })
    );
    expect(id).toBe("192.0.2.5");
  });

  it("falls back when x-forwarded-for has an empty first hop", () => {
    // Some L4 proxies prepend an empty entry when no upstream IP is
    // known (e.g. ", 10.0.0.1"). The outer header is truthy so the
    // RFC 7230 OWS-stripping in `Headers.get()` won't reduce it to "",
    // but the first comma-separated segment trims to empty — we must
    // fall through to the next header rather than rate-limiting all
    // such requests under a shared empty-string bucket.
    const id = rateLimitIdentifierFromRequest(
      makeRequest({ "x-forwarded-for": ", 10.0.0.1", "x-real-ip": "192.0.2.6" })
    );
    expect(id).toBe("192.0.2.6");
  });

  it("falls back to 'unknown' when x-forwarded-for has an empty first hop and no other headers", () => {
    const id = rateLimitIdentifierFromRequest(
      makeRequest({ "x-forwarded-for": ", , 10.0.0.1" })
    );
    // No x-real-ip / cf-connecting-ip → "unknown" rather than
    // returning a malformed empty string as a rate-limit key.
    expect(id).toBe("unknown");
  });

  it("falls back to cf-connecting-ip when neither x-forwarded-for nor x-real-ip is set", () => {
    const id = rateLimitIdentifierFromRequest(
      makeRequest({ "cf-connecting-ip": "192.0.2.10" })
    );
    expect(id).toBe("192.0.2.10");
  });

  it("returns 'unknown' when no proxy headers are present", () => {
    const id = rateLimitIdentifierFromRequest(makeRequest({}));
    expect(id).toBe("unknown");
  });

  it("returns 'unknown' when all proxy headers are empty/whitespace", () => {
    const id = rateLimitIdentifierFromRequest(
      makeRequest({
        "x-forwarded-for": "  ",
        "x-real-ip": "",
        "cf-connecting-ip": " "
      })
    );
    expect(id).toBe("unknown");
  });
});
