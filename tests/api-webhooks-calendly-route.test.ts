/**
 * POST /api/webhooks/calendly — the signed Calendly invitee.created
 * receiver: business selection, rate limiting, body caps, subscription
 * gating, signature verification wiring, and handler dispatch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({}))
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => ({ success: true })) }));
vi.mock("@/lib/db/calendly-webhook-subscriptions", () => ({
  getCalendlyWebhookSubscription: vi.fn()
}));
vi.mock("@/lib/calendly/webhook-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendly/webhook-inbound")>();
  return {
    ...actual,
    // The signature verifier stays REAL (that's the security wiring under
    // test); only the goal-firing handler is stubbed.
    handleCalendlyWebhookEvent: vi.fn()
  };
});

import { POST } from "@/app/api/webhooks/calendly/route";
import { rateLimit } from "@/lib/rate-limit";
import { getCalendlyWebhookSubscription } from "@/lib/db/calendly-webhook-subscriptions";
import { handleCalendlyWebhookEvent } from "@/lib/calendly/webhook-inbound";

const BIZ = "11111111-1111-4111-8111-111111111111";
const KEY = "sk-secret";

const ACTIVE_SUB = {
  id: "cws-1",
  business_id: BIZ,
  status: "active",
  subscription_uri: "https://api.calendly.com/webhook_subscriptions/WH1",
  signingKey: KEY,
  user_uri: "https://api.calendly.com/users/U1",
  connection_key: "calendly-direct:cx-1",
  last_attempt_at: "2026-07-18T00:00:00Z"
};

function signedRequest(body: string, opts: { key?: string; business?: string } = {}): Request {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", opts.key ?? KEY).update(`${t}.${body}`).digest("hex");
  return new Request(
    `http://localhost/api/webhooks/calendly?business=${opts.business ?? BIZ}`,
    {
      method: "POST",
      headers: { "Calendly-Webhook-Signature": `t=${t},v1=${v1}` },
      body
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockReturnValue({ success: true } as never);
  vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(ACTIVE_SUB as never);
  vi.mocked(handleCalendlyWebhookEvent).mockResolvedValue({
    handled: true,
    goalsFired: 1,
    jumpedRuns: 1
  });
});

describe("POST /api/webhooks/calendly", () => {
  it("verifies the signature and dispatches invitee.created to the handler", async () => {
    const body = JSON.stringify({ event: "invitee.created", payload: { email: "t@x.com" } });
    const res = await POST(signedRequest(body));
    expect(res.status).toBe(200);
    // The verified subscription row travels into the handler so it can
    // reject rows created by a different (switched) connection.
    expect(handleCalendlyWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      BIZ,
      { event: "invitee.created", payload: { email: "t@x.com" } },
      ACTIVE_SUB
    );
  });

  it("401s without a business uuid", async () => {
    const res = await POST(
      new Request("http://localhost/api/webhooks/calendly?business=nope", {
        method: "POST",
        body: "{}"
      })
    );
    expect(res.status).toBe(401);
    expect(handleCalendlyWebhookEvent).not.toHaveBeenCalled();
  });

  it("429s when rate limited", async () => {
    vi.mocked(rateLimit).mockReturnValue({ success: false } as never);
    const res = await POST(signedRequest("{}"));
    expect(res.status).toBe(429);
  });

  it("413s an oversized body", async () => {
    const res = await POST(signedRequest("x".repeat(64 * 1024 + 1)));
    expect(res.status).toBe(413);
  });

  it("401s when no active subscription (or signing key) exists", async () => {
    for (const sub of [null, { ...ACTIVE_SUB, status: "unsupported", signingKey: null }]) {
      vi.mocked(getCalendlyWebhookSubscription).mockResolvedValue(sub as never);
      const res = await POST(signedRequest("{}"));
      expect(res.status).toBe(401);
    }
    expect(handleCalendlyWebhookEvent).not.toHaveBeenCalled();
  });

  it("401s a delivery signed with the wrong key", async () => {
    const res = await POST(signedRequest("{}", { key: "attacker-key" }));
    expect(res.status).toBe(401);
    expect(handleCalendlyWebhookEvent).not.toHaveBeenCalled();
  });

  it("400s a signed but non-JSON body", async () => {
    const res = await POST(signedRequest("not json"));
    expect(res.status).toBe(400);
  });

  it("routes unexpected failures through the shared error handler", async () => {
    vi.mocked(getCalendlyWebhookSubscription).mockRejectedValue(new Error("db down"));
    const res = await POST(signedRequest("{}"));
    expect(res.status).toBe(500);
  });
});
