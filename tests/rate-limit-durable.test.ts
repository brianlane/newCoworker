import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the service client so we can drive `app_rate_limit_hit` responses
// (and failures) deterministically. rateLimitDurable resolves the client
// via a dynamic import, so the mock applies when the function runs.
const { rpcMock, serviceClientMock } = vi.hoisted(() => {
  const rpcMock = vi.fn();
  return {
    rpcMock,
    serviceClientMock: vi.fn(async () => ({ rpc: rpcMock }))
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: serviceClientMock
}));

import { rateLimitDurable } from "@/lib/rate-limit";

const CONFIG = { interval: 60_000, maxRequests: 5 };

beforeEach(() => {
  vi.clearAllMocks();
  serviceClientMock.mockImplementation(async () => ({ rpc: rpcMock }));
});

describe("rateLimitDurable", () => {
  it("maps a successful RPC payload (ok + hits + reset) to a RateLimitResult", async () => {
    rpcMock.mockResolvedValue({ data: { ok: true, hits: 2, reset: 1_900_000_000_000 }, error: null });

    const result = await rateLimitDurable("durable-ok", CONFIG);

    expect(serviceClientMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("app_rate_limit_hit", {
      p_key: "durable-ok",
      p_max: 5,
      p_window_seconds: 60
    });
    expect(result.success).toBe(true);
    expect(result.limit).toBe(5);
    expect(result.remaining).toBe(3);
    expect(result.reset).toBe(1_900_000_000_000);
  });

  it("reports failure (success=false) and defaults reset when the window is exhausted", async () => {
    rpcMock.mockResolvedValue({ data: { ok: false, hits: 99 }, error: null });

    const before = Date.now();
    const result = await rateLimitDurable("durable-exhausted", CONFIG);

    expect(result.success).toBe(false);
    expect(result.remaining).toBe(0);
    // No `reset` in payload → falls back to now + interval.
    expect(result.reset).toBeGreaterThanOrEqual(before + CONFIG.interval - 50);
  });

  it("treats a non-numeric hits as zero (full remaining)", async () => {
    rpcMock.mockResolvedValue({ data: { ok: true }, error: null });

    const result = await rateLimitDurable("durable-no-hits", CONFIG);

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(5);
  });

  it("fails open to the in-memory limiter when the RPC returns an error", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await rateLimitDurable("durable-rpc-error", CONFIG);

    // In-memory fallback: first hit succeeds, remaining = max - 1.
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("fails open when the RPC returns a non-object payload", async () => {
    rpcMock.mockResolvedValue({ data: 5, error: null });

    const result = await rateLimitDurable("durable-nonobject", CONFIG);

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("fails open when the RPC returns null data without an error", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });

    const result = await rateLimitDurable("durable-null-data", CONFIG);

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("fails open when resolving the service client throws", async () => {
    serviceClientMock.mockImplementationOnce(async () => {
      throw new Error("db unavailable");
    });

    const result = await rateLimitDurable("durable-throws", CONFIG);

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("fails open when the RPC stalls past the timeout (no error, just slow)", async () => {
    vi.useFakeTimers();
    try {
      // PostgREST hangs rather than erroring — the RPC never settles.
      rpcMock.mockReturnValue(new Promise(() => {}));
      const pending = rateLimitDurable("durable-timeout", CONFIG);
      // Drain the awaited client-resolution microtasks, then trip the deadline.
      await vi.advanceTimersByTimeAsync(2000);
      const result = await pending;
      expect(result.success).toBe(true);
      expect(result.remaining).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rounds sub-second intervals up to a one-second window", async () => {
    rpcMock.mockResolvedValue({ data: { ok: true, hits: 1 }, error: null });

    await rateLimitDurable("durable-window", { interval: 200, maxRequests: 1 });

    expect(rpcMock).toHaveBeenCalledWith("app_rate_limit_hit", {
      p_key: "durable-window",
      p_max: 1,
      p_window_seconds: 1
    });
  });
});
