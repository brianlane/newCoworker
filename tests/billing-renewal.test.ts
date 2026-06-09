import { describe, expect, it, vi } from "vitest";

// Mock the default Stripe client so tests that omit `options.stripe` exercise
// the `options.stripe ?? getStripe()` fallback branch without a real key/network.
const mockRetrieve = vi.fn();
vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({ subscriptions: { retrieve: mockRetrieve } })
}));

import { resolveActiveRenewalDate } from "@/lib/billing/renewal";

const NOW = new Date("2026-06-08T00:00:00Z");

function sub(overrides: Record<string, unknown> = {}) {
  return {
    status: "active",
    stripe_subscription_id: "sub_123",
    stripe_current_period_end: null,
    renewal_at: null,
    ...overrides
  } as never;
}

function stripeReturning(periodEndSeconds: number) {
  return {
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue({
        current_period_start: periodEndSeconds - 30 * 24 * 3600,
        current_period_end: periodEndSeconds
      })
    }
  } as never;
}

describe("resolveActiveRenewalDate", () => {
  it("returns null for a null subscription", async () => {
    expect(await resolveActiveRenewalDate(null)).toBeNull();
  });

  it("uses a fresh cached period end WITHOUT calling Stripe", async () => {
    const future = "2026-07-08T00:00:00Z";
    const stripe = { subscriptions: { retrieve: vi.fn() } } as never;
    const result = await resolveActiveRenewalDate(
      sub({ stripe_current_period_end: future, renewal_at: "2026-05-29T00:00:00Z" }),
      { stripe, now: NOW }
    );
    expect(result).toBe(future);
    expect((stripe as { subscriptions: { retrieve: ReturnType<typeof vi.fn> } }).subscriptions.retrieve)
      .not.toHaveBeenCalled();
  });

  it("fetches the live period end when the cache is stale (in the past)", async () => {
    // Stale cache (May 29) is the exact reported bug; live Stripe says July 1.
    const liveEndSecs = Math.floor(new Date("2026-07-01T00:00:00Z").getTime() / 1000);
    const stripe = stripeReturning(liveEndSecs);
    const result = await resolveActiveRenewalDate(
      sub({ stripe_current_period_end: "2026-05-29T00:00:00Z" }),
      { stripe, now: NOW }
    );
    expect(result).toBe("2026-07-01T00:00:00.000Z");
  });

  it("fetches live when there is no cached period end at all", async () => {
    const liveEndSecs = Math.floor(new Date("2026-07-01T00:00:00Z").getTime() / 1000);
    const stripe = stripeReturning(liveEndSecs);
    const result = await resolveActiveRenewalDate(sub({ stripe_current_period_end: null }), {
      stripe,
      now: NOW
    });
    expect(result).toBe("2026-07-01T00:00:00.000Z");
  });

  it("does NOT call Stripe for a non-active subscription", async () => {
    const stripe = { subscriptions: { retrieve: vi.fn() } } as never;
    const result = await resolveActiveRenewalDate(
      sub({ status: "canceled", renewal_at: "2026-05-29T00:00:00Z" }),
      { stripe, now: NOW }
    );
    expect(result).toBe("2026-05-29T00:00:00Z");
    expect((stripe as { subscriptions: { retrieve: ReturnType<typeof vi.fn> } }).subscriptions.retrieve)
      .not.toHaveBeenCalled();
  });

  it("does NOT call Stripe when there is no stripe_subscription_id", async () => {
    const stripe = { subscriptions: { retrieve: vi.fn() } } as never;
    const result = await resolveActiveRenewalDate(
      sub({ stripe_subscription_id: null, stripe_current_period_end: "2026-05-29T00:00:00Z" }),
      { stripe, now: NOW }
    );
    expect(result).toBe("2026-05-29T00:00:00Z");
  });

  it("falls back to the cached value when the live lookup throws", async () => {
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockRejectedValue(new Error("stripe down")) }
    } as never;
    const result = await resolveActiveRenewalDate(
      sub({ stripe_current_period_end: "2026-05-29T00:00:00Z" }),
      { stripe, now: NOW }
    );
    expect(result).toBe("2026-05-29T00:00:00Z");
  });

  it("falls back to renewal_at when live fails and there is no cached end", async () => {
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockRejectedValue(new Error("stripe down")) }
    } as never;
    const result = await resolveActiveRenewalDate(
      sub({ stripe_current_period_end: null, renewal_at: "2026-05-29T00:00:00Z" }),
      { stripe, now: NOW }
    );
    expect(result).toBe("2026-05-29T00:00:00Z");
  });

  it("uses the real wall clock when no `now` is supplied (fresh far-future cache)", async () => {
    // No `now` → exercises the `options.now ?? new Date()` default. A cached
    // end far in the future is always fresh against the real clock, so no
    // Stripe call happens.
    const stripe = { subscriptions: { retrieve: vi.fn() } } as never;
    const result = await resolveActiveRenewalDate(
      sub({ stripe_current_period_end: "2099-01-01T00:00:00Z" }),
      { stripe }
    );
    expect(result).toBe("2099-01-01T00:00:00Z");
    expect((stripe as { subscriptions: { retrieve: ReturnType<typeof vi.fn> } }).subscriptions.retrieve)
      .not.toHaveBeenCalled();
  });

  it("falls back to the default Stripe client when none is injected", async () => {
    // No `options.stripe` → exercises the `?? getStripe()` branch via the mock.
    const liveEndSecs = Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000);
    mockRetrieve.mockResolvedValueOnce({
      current_period_start: liveEndSecs - 30 * 24 * 3600,
      current_period_end: liveEndSecs
    });
    const result = await resolveActiveRenewalDate(
      sub({ stripe_current_period_end: "2026-05-29T00:00:00Z" }),
      { now: NOW }
    );
    expect(mockRetrieve).toHaveBeenCalledWith("sub_123");
    expect(result).toBe("2026-08-01T00:00:00.000Z");
  });

  it("falls back to cached/renewal_at when Stripe returns no period fields", async () => {
    // retrieve resolves an object with no current_period_* → the period cache
    // helper yields {}, so liveEnd is null and we fall back.
    const stripe = { subscriptions: { retrieve: vi.fn().mockResolvedValue({ id: "sub_123" }) } } as never;
    const result = await resolveActiveRenewalDate(
      sub({ stripe_current_period_end: null, renewal_at: "2026-05-29T00:00:00Z" }),
      { stripe, now: NOW }
    );
    expect(result).toBe("2026-05-29T00:00:00Z");
  });

  it("handles a non-Error rejection from Stripe and still falls back", async () => {
    // retrieve rejects with a plain string → exercises the `String(err)` arm
    // of the catch-block logger.
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockRejectedValue("stripe exploded") }
    } as never;
    const result = await resolveActiveRenewalDate(
      sub({ stripe_current_period_end: "2026-05-29T00:00:00Z" }),
      { stripe, now: NOW }
    );
    expect(result).toBe("2026-05-29T00:00:00Z");
  });

  it("falls back on timeout rather than blocking the page", async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 1000))
        )
      }
    } as never;
    const result = await resolveActiveRenewalDate(
      sub({ stripe_current_period_end: "2026-05-29T00:00:00Z" }),
      { stripe, now: NOW, timeoutMs: 20 }
    );
    expect(result).toBe("2026-05-29T00:00:00Z");
  });
});
