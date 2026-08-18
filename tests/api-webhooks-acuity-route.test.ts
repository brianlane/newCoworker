/**
 * The Acuity webhook receiver route.
 *
 * Response discipline is the point here. Acuity retries 5xx for 24 hours and
 * DISABLES the webhook after five days of continuous failure, so anything we
 * understand, including deliveries we deliberately ignore, must answer
 * 2xx. The single exception is a failure to read the appointment back, which
 * is genuinely transient. Getting this backwards costs a tenant their
 * real-time path silently.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => ({ success: true })) }));
vi.mock("@/lib/db/acuity-connections", () => ({ getAcuityConnection: vi.fn() }));
vi.mock("@/lib/acuity/webhook", async () => {
  const actual = await vi.importActual<typeof import("@/lib/acuity/webhook")>(
    "@/lib/acuity/webhook"
  );
  return {
    ACUITY_WEBHOOK_MAX_BODY_BYTES: actual.ACUITY_WEBHOOK_MAX_BODY_BYTES,
    AcuityHydrationError: actual.AcuityHydrationError,
    parseAcuityWebhookBody: actual.parseAcuityWebhookBody,
    processAcuityWebhookEvent: vi.fn()
  };
});

import { createHmac } from "node:crypto";
import { POST } from "@/app/api/webhooks/acuity/route";
import { getAcuityConnection } from "@/lib/db/acuity-connections";
import { rateLimit } from "@/lib/rate-limit";
import { AcuityHydrationError, processAcuityWebhookEvent } from "@/lib/acuity/webhook";

const BIZ = "11111111-1111-4111-8111-111111111111";
const KEY = "api-key";
const TOKEN = "tok123";
const BODY = "action=scheduled&id=500&calendarID=7";

const CONN = {
  id: "ac-1",
  business_id: BIZ,
  user_id: "1",
  apiKey: KEY,
  api_base_url: "https://acuityscheduling.com",
  webhook_verification_token: TOKEN,
  is_active: true
};

function sign(body: string, key = KEY): string {
  return createHmac("sha256", key).update(body, "utf8").digest("base64");
}

function req(
  body = BODY,
  { token = TOKEN, business = BIZ, signature = sign(body) } = {}
): Request {
  return new Request(
    `https://app.example.com/api/webhooks/acuity?business=${business}&token=${token}`,
    { method: "POST", body, headers: { "x-acuity-signature": signature } }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockReturnValue({ success: true } as never);
  vi.mocked(getAcuityConnection).mockResolvedValue(CONN as never);
  vi.mocked(processAcuityWebhookEvent).mockResolvedValue({
    hydrated: true,
    goalsFired: 0,
    jumpedRuns: 0,
    triggerRunsEnqueued: 1,
    ledgerSynced: true,
    contactSynced: true,
    flowRunsEnqueued: 0
  } as never);
});

describe("authentication", () => {
  it("accepts a correctly signed delivery", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(vi.mocked(processAcuityWebhookEvent)).toHaveBeenCalled();
  });

  it("rejects a missing business or token", async () => {
    expect((await POST(req(BODY, { token: "" }))).status).toBe(401);
    expect((await POST(req(BODY, { business: "not-a-uuid" }))).status).toBe(401);
  });

  it("rejects a wrong URL token before doing any signature work", async () => {
    const res = await POST(req(BODY, { token: "wrong-length-token" }));
    expect(res.status).toBe(401);
    expect(vi.mocked(processAcuityWebhookEvent)).not.toHaveBeenCalled();
  });

  it("rejects an unknown connection", async () => {
    vi.mocked(getAcuityConnection).mockResolvedValue(null as never);
    expect((await POST(req())).status).toBe(401);
  });

  it("rejects a signature computed with the wrong key", async () => {
    const res = await POST(req(BODY, { signature: sign(BODY, "other-key") }));
    expect(res.status).toBe(401);
  });

  it("rejects a tampered body", async () => {
    // The signature covers the RAW bytes, which is why the route must read
    // them before anything else touches the stream.
    const res = await POST(req("action=canceled&id=500", { signature: sign(BODY) }));
    expect(res.status).toBe(401);
  });

  it("rejects a missing signature header", async () => {
    const res = await POST(
      new Request(`https://app.example.com/api/webhooks/acuity?business=${BIZ}&token=${TOKEN}`, {
        method: "POST",
        body: BODY
      })
    );
    expect(res.status).toBe(401);
  });
});

describe("response discipline", () => {
  it("ABSORBS a delivery it cannot parse rather than failing it", async () => {
    // A non-2xx here would count toward Acuity's five-day disable window for
    // a payload that will never parse no matter how often it is retried.
    const body = "action=scheduled";
    const res = await POST(req(body, { signature: sign(body) }));
    expect(res.status).toBe(200);
    expect(vi.mocked(processAcuityWebhookEvent)).not.toHaveBeenCalled();
  });

  it("returns 500 ONLY for a hydration failure, which is worth retrying", async () => {
    vi.mocked(processAcuityWebhookEvent).mockRejectedValue(
      new AcuityHydrationError("could not read appointment 500")
    );
    const res = await POST(req());
    expect(res.status).toBe(500);
  });

  it("ABSORBS a rate-limited delivery rather than answering 429", async () => {
    // Acuity counts every non-2xx toward the five-day disable window, so a
    // retry burst hitting our own limiter would help kill the very endpoint
    // the limiter protects. The poller sees the change regardless.
    vi.mocked(rateLimit).mockReturnValue({ success: false } as never);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(vi.mocked(processAcuityWebhookEvent)).not.toHaveBeenCalled();
  });

  it("ABSORBS a delivery for a soft-disabled connection", async () => {
    // Pausing an integration must not permanently kill the webhook: 401s
    // here would count toward the five-day disable, so an owner who paused
    // for a week would come back to a dead endpoint.
    vi.mocked(getAcuityConnection).mockResolvedValue({ ...CONN, is_active: false } as never);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(vi.mocked(processAcuityWebhookEvent)).not.toHaveBeenCalled();
  });

  it("still refuses an UNSIGNED delivery to an inactive connection", async () => {
    // The pause is checked after the signature, so an unsigned request
    // cannot learn that a business exists.
    vi.mocked(getAcuityConnection).mockResolvedValue({ ...CONN, is_active: false } as never);
    const res = await POST(req(BODY, { signature: sign(BODY, "wrong") }));
    expect(res.status).toBe(401);
  });

  it("refuses an oversized payload", async () => {
    const huge = `id=500&pad=${"x".repeat(70_000)}`;
    const res = await POST(req(huge, { signature: sign(huge) }));
    expect(res.status).toBe(400);
  });

  it("hands an unexpected processing error to the shared route handler", async () => {
    vi.mocked(processAcuityWebhookEvent).mockRejectedValue(new Error("something else"));
    const res = await POST(req());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
