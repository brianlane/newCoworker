/**
 * POST /api/contact — the public contact form. Focus: the additive
 * contact-form-sink flow event (HQ dogfooding) around the pre-existing
 * email-only behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock("@/lib/email/client", () => ({
  sendOwnerEmail: vi.fn()
}));

vi.mock("@/lib/db/contact-form-sink", () => ({
  getContactFormSinkBusinessId: vi.fn()
}));

vi.mock("@/lib/ai-flows/webhook-events", () => ({
  processWebhookFlowEvent: vi.fn()
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimitDurable: vi.fn(),
  rateLimitIdentifierFromRequest: vi.fn().mockReturnValue("ip:1.2.3.4")
}));

import { POST } from "@/app/api/contact/route";
import { sendOwnerEmail } from "@/lib/email/client";
import { getContactFormSinkBusinessId } from "@/lib/db/contact-form-sink";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import { rateLimitDurable } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const SINK = "11111111-1111-4111-8111-111111111111";

const VALID = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  businessName: "Analytical Engines",
  subject: "Pricing question",
  message: "How much for Standard?",
  extraField: ""
};

function req(body: unknown): Request {
  return new Request("http://localhost/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/contact route", () => {
  const original = process.env;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...original, RESEND_API_KEY: "re_test", CONTACT_EMAIL: "team@x.com" };
    vi.mocked(rateLimitDurable).mockResolvedValue({ success: true } as never);
    vi.mocked(sendOwnerEmail).mockResolvedValue("msg_1");
    vi.mocked(getContactFormSinkBusinessId).mockResolvedValue(SINK);
    vi.mocked(processWebhookFlowEvent).mockResolvedValue({
      enqueued: 1,
      flowsEvaluated: 1,
      flowsMatched: 1
    });
  });
  afterEach(() => {
    process.env = original;
  });

  it("delivers the email AND enqueues the sink flow event", async () => {
    const res = await POST(req(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendOwnerEmail).toHaveBeenCalledTimes(1);
    expect(processWebhookFlowEvent).toHaveBeenCalledWith(SINK, {
      source: "contact_form",
      data: {
        name: "Ada Lovelace",
        email: "ada@example.com",
        business_name: "Analytical Engines",
        subject: "Pricing question",
        message: "How much for Standard?"
      }
    });
  });

  it("skips the flow event when no sink is designated (email-only behavior)", async () => {
    vi.mocked(getContactFormSinkBusinessId).mockResolvedValue(null);
    const res = await POST(req(VALID));
    expect(res.status).toBe(200);
    expect(processWebhookFlowEvent).not.toHaveBeenCalled();
  });

  it("still returns ok when the sink lookup / flow event fails (additive only)", async () => {
    vi.mocked(getContactFormSinkBusinessId).mockRejectedValueOnce(new Error("db down"));
    const res = await POST(req(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(logger.warn).toHaveBeenCalledWith(
      "contact form flow event failed",
      expect.objectContaining({ error: "db down" })
    );

    vi.mocked(processWebhookFlowEvent).mockRejectedValueOnce("flow boom");
    const res2 = await POST(req(VALID));
    expect(res2.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      "contact form flow event failed",
      expect.objectContaining({ error: "flow boom" })
    );
  });

  it("does not fire the flow event when the email failed (retry re-digests to the same dedupe key)", async () => {
    vi.mocked(sendOwnerEmail).mockResolvedValue(null as never);
    const res = await POST(req(VALID));
    expect(res.status).toBe(502);
    expect(processWebhookFlowEvent).not.toHaveBeenCalled();
  });

  it("keeps the pre-existing guards: honeypot, validation, rate limit, missing key", async () => {
    // Honeypot: bots that fill every field get a quiet 200, nothing sent.
    const honeypot = await POST(req({ ...VALID, extraField: "gotcha" }));
    expect(honeypot.status).toBe(200);
    expect(sendOwnerEmail).not.toHaveBeenCalled();
    expect(processWebhookFlowEvent).not.toHaveBeenCalled();

    // Validation.
    const invalid = await POST(req({ ...VALID, email: "not-an-email" }));
    expect(invalid.status).toBe(400);
    const missing = await POST(req({ ...VALID, name: "" }));
    expect(missing.status).toBe(400);
    const badBody = await POST(
      new Request("http://localhost/api/contact", { method: "POST", body: "{" })
    );
    expect(badBody.status).toBe(400);

    // Rate limit.
    vi.mocked(rateLimitDurable).mockResolvedValueOnce({ success: false } as never);
    const limited = await POST(req(VALID));
    expect(limited.status).toBe(429);

    // Missing RESEND_API_KEY → 503, no flow event.
    delete process.env.RESEND_API_KEY;
    const nokey = await POST(req(VALID));
    expect(nokey.status).toBe(503);
    expect(processWebhookFlowEvent).not.toHaveBeenCalled();
  });
});
