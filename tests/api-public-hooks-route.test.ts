import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/public-api/auth", () => ({
  authenticatePublicApiRequest: vi.fn()
}));

vi.mock("@/lib/db/webhook-subscriptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/webhook-subscriptions")>();
  return {
    MAX_HOOKS_PER_BUSINESS: actual.MAX_HOOKS_PER_BUSINESS,
    countActiveWebhookSubscriptions: vi.fn(),
    createWebhookSubscription: vi.fn(),
    deleteWebhookSubscription: vi.fn(),
    listWebhookSubscriptions: vi.fn()
  };
});

import { GET, POST } from "@/app/api/public/v1/hooks/route";
import { DELETE } from "@/app/api/public/v1/hooks/[id]/route";
import { authenticatePublicApiRequest } from "@/lib/public-api/auth";
import {
  MAX_HOOKS_PER_BUSINESS,
  countActiveWebhookSubscriptions,
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookSubscriptions
} from "@/lib/db/webhook-subscriptions";

const AUTH = { businessId: "biz-1", apiKeyId: "key-1" };
const HOOK_ID = "11111111-1111-4111-8111-111111111111";

const SUB = {
  id: HOOK_ID,
  business_id: "biz-1",
  event: "sms.inbound" as const,
  target_url: "https://hooks.zapier.com/abc",
  active: true,
  last_cursor: "2026-07-01T00:00:00Z",
  last_cursor_id: "00000000-0000-0000-0000-000000000000",
  consecutive_failures: 0,
  api_key_id: "key-1",
  created_at: "2026-07-01T00:00:00Z"
};

function postReq(body: unknown): Request {
  return new Request("http://localhost/api/public/v1/hooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function deleteReq(id: string) {
  return [
    new Request(`http://localhost/api/public/v1/hooks/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) }
  ] as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticatePublicApiRequest).mockResolvedValue(AUTH);
  vi.mocked(countActiveWebhookSubscriptions).mockResolvedValue(0);
  vi.mocked(createWebhookSubscription).mockResolvedValue(SUB);
  vi.mocked(listWebhookSubscriptions).mockResolvedValue([SUB]);
  vi.mocked(deleteWebhookSubscription).mockResolvedValue(true);
});

describe("GET /api/public/v1/hooks", () => {
  it("401s without a valid API key", async () => {
    vi.mocked(authenticatePublicApiRequest).mockResolvedValue(null);
    expect((await GET(new Request("http://localhost/api/public/v1/hooks"))).status).toBe(401);
  });

  it("lists the business's active hooks in the public shape", async () => {
    const res = await GET(new Request("http://localhost/api/public/v1/hooks"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      {
        id: HOOK_ID,
        event: "sms.inbound",
        target_url: "https://hooks.zapier.com/abc",
        created_at: "2026-07-01T00:00:00Z"
      }
    ]);
    expect(listWebhookSubscriptions).toHaveBeenCalledWith("biz-1");
  });
});

describe("POST /api/public/v1/hooks", () => {
  it("401s without a valid API key", async () => {
    vi.mocked(authenticatePublicApiRequest).mockResolvedValue(null);
    const res = await POST(postReq({ event: "sms.inbound", target_url: "https://x.example/h" }));
    expect(res.status).toBe(401);
  });

  it("validates event type and https target_url", async () => {
    expect(
      (await POST(postReq({ event: "nope", target_url: "https://x.example/h" }))).status
    ).toBe(400);
    expect(
      (await POST(postReq({ event: "sms.inbound", target_url: "http://insecure.example/h" })))
        .status
    ).toBe(400);
    expect((await POST(postReq(null))).status).toBe(400);
  });

  it("creates a subscription bound to the API key", async () => {
    const res = await POST(
      postReq({ event: "sms.inbound", target_url: "https://hooks.zapier.com/abc" })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe(HOOK_ID);
    expect(createWebhookSubscription).toHaveBeenCalledWith({
      businessId: "biz-1",
      event: "sms.inbound",
      targetUrl: "https://hooks.zapier.com/abc",
      apiKeyId: "key-1"
    });
  });

  it("409s at the per-business hook cap", async () => {
    vi.mocked(countActiveWebhookSubscriptions).mockResolvedValue(MAX_HOOKS_PER_BUSINESS);
    const res = await POST(
      postReq({ event: "sms.inbound", target_url: "https://hooks.zapier.com/abc" })
    );
    expect(res.status).toBe(409);
    expect(createWebhookSubscription).not.toHaveBeenCalled();
  });

  it("409s when the DB cap trigger rejects a racing insert", async () => {
    // Pre-check passed but the webhook_subscriptions_cap trigger fired — a
    // concurrent subscribe won the race.
    vi.mocked(createWebhookSubscription).mockRejectedValue(
      new Error("createWebhookSubscription: Webhook limit reached (25) for business biz-1")
    );
    const res = await POST(
      postReq({ event: "sms.inbound", target_url: "https://hooks.zapier.com/abc" })
    );
    expect(res.status).toBe(409);
  });

  it("rethrows non-cap insert failures as 500", async () => {
    vi.mocked(createWebhookSubscription).mockRejectedValue(
      new Error("createWebhookSubscription: connection reset")
    );
    const res = await POST(
      postReq({ event: "sms.inbound", target_url: "https://hooks.zapier.com/abc" })
    );
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/public/v1/hooks/:id", () => {
  it("401s without a valid API key", async () => {
    vi.mocked(authenticatePublicApiRequest).mockResolvedValue(null);
    const [request, ctx] = deleteReq(HOOK_ID);
    expect((await DELETE(request, ctx)).status).toBe(401);
  });

  it("400s on a non-uuid id", async () => {
    const [request, ctx] = deleteReq("not-a-uuid");
    expect((await DELETE(request, ctx)).status).toBe(400);
  });

  it("deletes business-scoped and 404s when nothing matched", async () => {
    const [request, ctx] = deleteReq(HOOK_ID);
    const res = await DELETE(request, ctx);
    expect(res.status).toBe(200);
    expect(deleteWebhookSubscription).toHaveBeenCalledWith("biz-1", HOOK_ID);

    vi.mocked(deleteWebhookSubscription).mockResolvedValue(false);
    const [request2, ctx2] = deleteReq(HOOK_ID);
    expect((await DELETE(request2, ctx2)).status).toBe(404);
  });
});
