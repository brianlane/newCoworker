import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/public-api/auth", () => ({
  authenticatePublicApiRequest: vi.fn()
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, limit: 120, remaining: 119, reset: 0 }))
}));

vi.mock("@/lib/ai-flows/webhook-events", () => ({
  processWebhookFlowEvent: vi.fn()
}));

import { POST } from "@/app/api/public/v1/flow-events/route";
import { authenticatePublicApiRequest } from "@/lib/public-api/auth";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import { rateLimit } from "@/lib/rate-limit";

const AUTH = { businessId: "biz-1", apiKeyId: "key-1" };

function req(body: unknown): Request {
  return new Request("http://localhost/api/public/v1/flow-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockReturnValue({ success: true, limit: 120, remaining: 119, reset: 0 });
  vi.mocked(authenticatePublicApiRequest).mockResolvedValue(AUTH);
  vi.mocked(processWebhookFlowEvent).mockResolvedValue({
    enqueued: 1,
    flowsEvaluated: 2,
    flowsMatched: 1
  });
});

describe("POST /api/public/v1/flow-events", () => {
  it("401s without a valid API key", async () => {
    vi.mocked(authenticatePublicApiRequest).mockResolvedValue(null);
    const res = await POST(req({ data: { a: 1 } }));
    expect(res.status).toBe(401);
    expect(processWebhookFlowEvent).not.toHaveBeenCalled();
  });

  it("400s on a missing/invalid data object", async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ data: "not-an-object" }))).status).toBe(400);
    expect((await POST(req(null))).status).toBe(400);
  });

  it("413s an oversized payload", async () => {
    const res = await POST(req({ data: { blob: "x".repeat(70 * 1024) } }));
    expect(res.status).toBe(413);
    expect(processWebhookFlowEvent).not.toHaveBeenCalled();
  });

  it("429s when the per-business limiter rejects", async () => {
    vi.mocked(rateLimit).mockReturnValue({
      success: false,
      limit: 120,
      remaining: 0,
      reset: Date.now() + 1000
    });
    const res = await POST(req({ data: { a: 1 } }));
    expect(res.status).toBe(429);
    expect(processWebhookFlowEvent).not.toHaveBeenCalled();
  });

  it("processes the event for the key's business and reports enqueued runs", async () => {
    const res = await POST(
      req({
        source: "facebook_lead_ads",
        event_id: "lead-1",
        data: { full_name: "Jane", phone_number: "+16025551234" }
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ enqueued: 1, flows_evaluated: 2, flows_matched: 1 });
    expect(processWebhookFlowEvent).toHaveBeenCalledWith("biz-1", {
      source: "facebook_lead_ads",
      eventId: "lead-1",
      data: { full_name: "Jane", phone_number: "+16025551234" }
    });
  });

  it('defaults a blank source to "webhook"', async () => {
    await POST(req({ source: "  ", data: { a: 1 } }));
    // A whitespace-only source fails min(1)? No — zod sees length 2; the route
    // trims it to empty and falls back to the default label.
    expect(processWebhookFlowEvent).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ source: "webhook" })
    );
  });

  it("500s (generic) when processing throws", async () => {
    vi.mocked(processWebhookFlowEvent).mockRejectedValue(new Error("db down"));
    const res = await POST(req({ data: { a: 1 } }));
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
