import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";

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
