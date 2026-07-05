import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/public-api/auth", () => ({
  authenticatePublicApiRequest: vi.fn()
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, limit: 60, remaining: 59, reset: 0 }))
}));

vi.mock("@/lib/telnyx/messaging", () => ({
  getTelnyxMessagingForBusiness: vi.fn(),
  sendTelnyxSms: vi.fn()
}));

const insertSingleMock = vi.fn();
const insertMock = vi.fn(() => ({ select: vi.fn(() => ({ single: insertSingleMock })) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({
    from: vi.fn(() => ({ insert: insertMock }))
  }))
}));

import { POST } from "@/app/api/public/v1/messages/route";
import { authenticatePublicApiRequest } from "@/lib/public-api/auth";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { rateLimit } from "@/lib/rate-limit";

const AUTH = { businessId: "biz-1", apiKeyId: "key-1" };

function req(body: unknown): Request {
  return new Request("http://localhost/api/public/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockReturnValue({ success: true, limit: 60, remaining: 59, reset: 0 });
  vi.mocked(authenticatePublicApiRequest).mockResolvedValue(AUTH);
  vi.mocked(getTelnyxMessagingForBusiness).mockResolvedValue({
    fromE164: "+16025550100"
  } as never);
  vi.mocked(sendTelnyxSms).mockResolvedValue({ id: "tx-1", channel: "sms" } as never);
  insertSingleMock.mockResolvedValue({ data: { id: "log-1" }, error: null });
});

describe("POST /api/public/v1/messages", () => {
  it("401s without a valid API key", async () => {
    vi.mocked(authenticatePublicApiRequest).mockResolvedValue(null);
    const res = await POST(req({ to: "+16025551234", text: "hi" }));
    expect(res.status).toBe(401);
  });

  it("400s on an unparseable destination or empty text", async () => {
    expect((await POST(req({ to: "not-a-number", text: "hi" }))).status).toBe(400);
    expect((await POST(req({ to: "+16025551234", text: "" }))).status).toBe(400);
    expect((await POST(req(null))).status).toBe(400);
  });

  it("429s when the per-business limiter rejects", async () => {
    vi.mocked(rateLimit).mockReturnValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 1000
    });
    const res = await POST(req({ to: "+16025551234", text: "hi" }));
    expect(res.status).toBe(429);
  });

  it("sends through the metered path and logs with source 'api'", async () => {
    const res = await POST(req({ to: "+16025551234", text: "hello from zapier" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ message_id: "tx-1", log_id: "log-1", channel: "sms" });

    expect(sendTelnyxSms).toHaveBeenCalledWith(
      expect.anything(),
      "+16025551234",
      "hello from zapier",
      { meterBusinessId: "biz-1" }
    );
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        to_e164: "+16025551234",
        source: "api",
        telnyx_message_id: "tx-1"
      })
    );
  });

  it("409s on quota errors, 502 on other Telnyx failures", async () => {
    vi.mocked(sendTelnyxSms).mockRejectedValue(new Error("Monthly SMS limit reached"));
    expect((await POST(req({ to: "+16025551234", text: "hi" }))).status).toBe(409);

    vi.mocked(sendTelnyxSms).mockRejectedValue(new Error("Telnyx 400: invalid destination"));
    expect((await POST(req({ to: "+16025551234", text: "hi" }))).status).toBe(502);
  });

  it("still succeeds when the outbound log insert fails (SMS already sent)", async () => {
    insertSingleMock.mockResolvedValue({ data: null, error: { message: "insert failed" } });
    const res = await POST(req({ to: "+16025551234", text: "hi" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.log_id).toBeNull();
  });
});
