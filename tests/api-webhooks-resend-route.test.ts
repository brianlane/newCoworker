/**
 * The Resend delivery webhook receiver route.
 *
 * Response discipline: Resend retries non-2xx and eventually disables a
 * failing endpoint, so a receipt we understand must answer 2xx even when it
 * matched no row (which is the COMMON case: Resend fires for every message
 * on the account, most of which this system never logged). Signature
 * failures are the deliberate exception, since accepting one would let a
 * forged POST mark a delivered alert as bounced.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/resend-webhook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/resend-webhook")>();
  return { ...actual, processResendDeliveryEvent: vi.fn() };
});

import { POST } from "@/app/api/webhooks/resend/route";
import { processResendDeliveryEvent } from "@/lib/email/resend-webhook";

const SECRET = `whsec_${Buffer.from("super-secret-key").toString("base64")}`;

function post(body: string, over: Record<string, string> = {}): Request {
  const id = "msg_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
  const signature = `v1,${createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`, "utf8")
    .digest("base64")}`;
  return new Request("https://app.example.com/api/webhooks/resend", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
      ...over
    },
    body
  });
}

const DELIVERED = JSON.stringify({
  type: "email.delivered",
  created_at: "2026-08-26T06:00:00.000Z",
  data: { email_id: "re_1", to: ["owner@example.com"] }
});

describe("POST /api/webhooks/resend", () => {
  beforeEach(() => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    vi.mocked(processResendDeliveryEvent).mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    vi.mocked(processResendDeliveryEvent).mockReset();
  });

  it("applies a signed receipt", async () => {
    const res = await POST(post(DELIVERED));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { applied: true, ignored: false }
    });
    expect(processResendDeliveryEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "delivered", providerMessageId: "re_1" })
    );
  });

  it("answers 200 when the receipt matched no row of ours", async () => {
    vi.mocked(processResendDeliveryEvent).mockResolvedValue(false);
    const res = await POST(post(DELIVERED));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: { applied: false } });
  });

  it("answers 200 and does nothing for an event type it does not model", async () => {
    const res = await POST(post(JSON.stringify({ type: "email.opened", data: { email_id: "x" } })));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: { ignored: true } });
    expect(processResendDeliveryEvent).not.toHaveBeenCalled();
  });

  it("refuses an unsigned or wrongly signed delivery", async () => {
    const res = await POST(post(DELIVERED, { "svix-signature": "v1,forged" }));
    expect(res.status).toBe(401);
    expect(processResendDeliveryEvent).not.toHaveBeenCalled();
  });

  it("refuses everything while the secret is unset", async () => {
    // Unconfigured must not mean "trust anyone": a forged receipt could mark
    // a delivered alert as bounced.
    delete process.env.RESEND_WEBHOOK_SECRET;
    expect((await POST(post(DELIVERED))).status).toBe(401);
    process.env.RESEND_WEBHOOK_SECRET = "   ";
    expect((await POST(post(DELIVERED))).status).toBe(401);
  });

  it("refuses a body that is not JSON", async () => {
    const res = await POST(post("not json"));
    expect(res.status).toBe(400);
  });

  it("refuses an oversized body before parsing it", async () => {
    const res = await POST(post(JSON.stringify({ pad: "x".repeat(300 * 1024) })));
    expect(res.status).toBe(413);
  });
});
