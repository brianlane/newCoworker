/**
 * Resend delivery webhook (src/lib/email/resend-webhook.ts).
 *
 * The signature tests carry the weight here. This endpoint can mark a
 * delivered alert as bounced, so an unsigned or replayed POST has to be
 * refused rather than merely logged.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const applyEmailDeliveryStatus = vi.fn(async (_input: unknown) => ({
  outcome: "applied",
  businessId: null as string | null
}));
vi.mock("@/lib/email/delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/delivery")>()),
  applyEmailDeliveryStatus: (input: unknown) => applyEmailDeliveryStatus(input)
}));

const recordSystemLog = vi.fn(async (_input: unknown) => {});
vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: (input: unknown) => recordSystemLog(input)
}));

const warn = vi.fn((_msg: string, _meta?: unknown) => {});
vi.mock("@/lib/logger", () => ({
  logger: { warn: (msg: string, meta?: unknown) => warn(msg, meta) }
}));

import {
  parseResendWebhookBody,
  processResendDeliveryEvent,
  RESEND_WEBHOOK_TOLERANCE_SECONDS,
  verifyResendWebhookSignature
} from "@/lib/email/resend-webhook";

const BIZ = "11111111-1111-4111-8111-111111111111";
const SECRET = `whsec_${Buffer.from("super-secret-key").toString("base64")}`;
const NOW = new Date("2026-08-26T06:00:00.000Z");
const TS = String(Math.floor(NOW.getTime() / 1000));

function sign(body: string, id = "msg_1", timestamp = TS, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`, "utf8").digest("base64");
}

function headers(body: string, over: Partial<Record<"id" | "timestamp" | "signature", string | null>> = {}) {
  return {
    id: "msg_1",
    timestamp: TS,
    signature: `v1,${sign(body)}`,
    ...over
  };
}

describe("verifyResendWebhookSignature", () => {
  const body = '{"type":"email.delivered"}';

  it("accepts a correctly signed delivery", () => {
    expect(verifyResendWebhookSignature(body, headers(body), SECRET, NOW)).toBe(true);
  });

  it("accepts during a secret rotation, when several signatures are sent", () => {
    // Svix sends one entry per active secret. Checking only the first would
    // drop every delivery for the length of a rotation.
    const sig = `v1,${sign(body, "msg_1", TS, `whsec_${Buffer.from("old-key").toString("base64")}`)} v1,${sign(body)}`;
    expect(
      verifyResendWebhookSignature(body, headers(body, { signature: sig }), SECRET, NOW)
    ).toBe(true);
  });

  it("skips an unknown signature version instead of failing on it", () => {
    const sig = `v2,${sign(body)} v1,${sign(body)}`;
    expect(
      verifyResendWebhookSignature(body, headers(body, { signature: sig }), SECRET, NOW)
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const hdrs = headers(body);
    expect(verifyResendWebhookSignature('{"type":"email.bounced"}', hdrs, SECRET, NOW)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const other = `whsec_${Buffer.from("not-the-key").toString("base64")}`;
    const sig = `v1,${sign(body, "msg_1", TS, other)}`;
    expect(
      verifyResendWebhookSignature(body, headers(body, { signature: sig }), SECRET, NOW)
    ).toBe(false);
  });

  it("rejects a replayed delivery outside the tolerance window", () => {
    // A captured receipt replayed weeks later must not be able to rewrite a
    // row. The timestamp is signed, so it cannot be edited to slip through.
    const old = String(Math.floor(NOW.getTime() / 1000) - RESEND_WEBHOOK_TOLERANCE_SECONDS - 1);
    const sig = `v1,${sign(body, "msg_1", old)}`;
    expect(
      verifyResendWebhookSignature(body, { id: "msg_1", timestamp: old, signature: sig }, SECRET, NOW)
    ).toBe(false);
  });

  it("accepts a delivery at the edge of the tolerance window, in both directions", () => {
    for (const offset of [-RESEND_WEBHOOK_TOLERANCE_SECONDS, RESEND_WEBHOOK_TOLERANCE_SECONDS]) {
      const ts = String(Math.floor(NOW.getTime() / 1000) + offset);
      const sig = `v1,${sign(body, "msg_1", ts)}`;
      expect(
        verifyResendWebhookSignature(body, { id: "msg_1", timestamp: ts, signature: sig }, SECRET, NOW)
      ).toBe(true);
    }
  });

  it("rejects a non-numeric timestamp", () => {
    expect(
      verifyResendWebhookSignature(body, headers(body, { timestamp: "not-a-time" }), SECRET, NOW)
    ).toBe(false);
  });

  it("rejects when any signing header is missing", () => {
    for (const key of ["id", "timestamp", "signature"] as const) {
      expect(
        verifyResendWebhookSignature(body, headers(body, { [key]: null }), SECRET, NOW)
      ).toBe(false);
    }
  });

  it("rejects when the secret is blank or decodes to nothing", () => {
    expect(verifyResendWebhookSignature(body, headers(body), "", NOW)).toBe(false);
    expect(verifyResendWebhookSignature(body, headers(body), "whsec_", NOW)).toBe(false);
  });

  it("rejects a malformed signature entry", () => {
    // No comma, so no signature half at all.
    expect(
      verifyResendWebhookSignature(body, headers(body, { signature: "v1" }), SECRET, NOW)
    ).toBe(false);
    // Right shape, wrong length: must not reach timingSafeEqual, which
    // throws on mismatched buffers.
    expect(
      verifyResendWebhookSignature(body, headers(body, { signature: "v1,short" }), SECRET, NOW)
    ).toBe(false);
  });

  it("defaults its clock to now", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v1,${sign(body, "msg_1", ts)}`;
    expect(
      verifyResendWebhookSignature(body, { id: "msg_1", timestamp: ts, signature: sig }, SECRET)
    ).toBe(true);
  });
});

describe("parseResendWebhookBody", () => {
  it("reads a delivered receipt", () => {
    expect(
      parseResendWebhookBody({
        type: "email.delivered",
        created_at: "2026-08-26T06:00:00.000Z",
        data: { email_id: "re_1", to: ["owner@example.com"], subject: "Urgent: new lead" }
      })
    ).toEqual({
      status: "delivered",
      providerMessageId: "re_1",
      to: "owner@example.com",
      subject: "Urgent: new lead",
      errorCode: null,
      errorMessage: null,
      occurredAt: "2026-08-26T06:00:00.000Z"
    });
  });

  it("reads a bounce with its classification and reason", () => {
    const parsed = parseResendWebhookBody({
      type: "email.bounced",
      created_at: "2026-08-26T06:00:00.000Z",
      data: {
        email_id: "re_2",
        to: "owner@example.com",
        bounce: { type: "Permanent", subType: "NoEmail", message: "Mailbox does not exist" }
      }
    });
    expect(parsed).toMatchObject({
      status: "bounced",
      errorCode: "Permanent",
      errorMessage: "Mailbox does not exist"
    });
  });

  it("falls back through the reason fields each event shape uses", () => {
    expect(
      parseResendWebhookBody({
        type: "email.bounced",
        data: { email_id: "re_3", bounce: { subType: "Suppressed" } }
      })
    ).toMatchObject({ errorCode: "Suppressed", errorMessage: null });

    expect(
      parseResendWebhookBody({
        type: "email.failed",
        data: { email_id: "re_4", failed: { reason: "Domain not verified" } }
      })
    ).toMatchObject({ status: "failed", errorMessage: "Domain not verified" });

    expect(
      parseResendWebhookBody({
        type: "email.failed",
        data: { email_id: "re_5", reason: "Rejected upstream" }
      })
    ).toMatchObject({ errorMessage: "Rejected upstream" });
  });

  it("keeps no error detail on a non-failure receipt", () => {
    expect(
      parseResendWebhookBody({
        type: "email.delivered",
        data: { email_id: "re_6", bounce: { type: "Permanent", message: "stale" } }
      })
    ).toMatchObject({ errorCode: null, errorMessage: null });
  });

  it("accepts either provider id field", () => {
    expect(parseResendWebhookBody({ type: "email.sent", data: { id: "re_7" } })).toMatchObject({
      providerMessageId: "re_7"
    });
  });

  it("handles every recipient shape", () => {
    const at = (to: unknown) =>
      parseResendWebhookBody({ type: "email.sent", data: { email_id: "re_8", to } })?.to;
    expect(at("owner@example.com")).toBe("owner@example.com");
    expect(at(["  owner@example.com  ", "cc@example.com"])).toBe("owner@example.com");
    // Blank entries are skipped rather than returned as an empty address.
    expect(at(["", "second@example.com"])).toBe("second@example.com");
    expect(at([])).toBeNull();
    expect(at([{ address: "x" }])).toBeNull();
    expect(at("   ")).toBeNull();
    expect(at(undefined)).toBeNull();
  });

  it("nulls an unusable timestamp rather than dating the receipt to 1970", () => {
    // The Meta receipt path shipped exactly this bug with unix seconds; a
    // 1970 stamp sorts the failure feed wrong forever.
    expect(
      parseResendWebhookBody({ type: "email.sent", created_at: "nonsense", data: { email_id: "re_9" } })
        ?.occurredAt
    ).toBeNull();
    expect(
      parseResendWebhookBody({ type: "email.sent", data: { email_id: "re_9" } })?.occurredAt
    ).toBeNull();
    // The envelope wins, but `data` is used when the envelope has none.
    expect(
      parseResendWebhookBody({
        type: "email.sent",
        data: { email_id: "re_9", created_at: "2026-08-26T07:00:00.000Z" }
      })?.occurredAt
    ).toBe("2026-08-26T07:00:00.000Z");
  });

  it("returns null for anything it does not model", () => {
    expect(parseResendWebhookBody(null)).toBeNull();
    expect(parseResendWebhookBody("nope")).toBeNull();
    expect(parseResendWebhookBody({})).toBeNull();
    expect(parseResendWebhookBody({ type: "email.opened", data: { email_id: "re_x" } })).toBeNull();
    // Modelled type, but nothing to key the row lookup on.
    expect(parseResendWebhookBody({ type: "email.delivered", data: {} })).toBeNull();
    expect(parseResendWebhookBody({ type: "email.delivered" })).toBeNull();
  });
});

describe("processResendDeliveryEvent", () => {
  const event = {
    status: "bounced" as const,
    providerMessageId: "re_1",
    to: "owner@example.com",
    subject: "Urgent: new lead",
    errorCode: "Permanent",
    errorMessage: "Mailbox does not exist",
    occurredAt: "2026-08-26T06:00:00.000Z"
  };

  beforeEach(() => {
    applyEmailDeliveryStatus.mockReset();
    recordSystemLog.mockClear();
    warn.mockClear();
  });

  it("raises a failed delivery where an operator will see it", async () => {
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "applied", businessId: BIZ });
    expect(await processResendDeliveryEvent(event)).toBe(true);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        level: "error",
        source: "email",
        event: "email_delivery_failed"
      })
    );
    const { message } = recordSystemLog.mock.calls[0][0] as unknown as { message: string };
    expect(message).toContain("owner@example.com");
    expect(message).toContain("Mailbox does not exist");
  });

  it("names the failure even when the receipt carried no detail", async () => {
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "applied", businessId: BIZ });
    await processResendDeliveryEvent({
      ...event,
      status: "complained",
      to: null,
      errorMessage: null
    });
    const { message } = recordSystemLog.mock.calls[0][0] as unknown as { message: string };
    expect(message).toBe("Email was not delivered (complained)");
  });

  it("stays quiet about a routine delivery", async () => {
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "applied", businessId: BIZ });
    expect(await processResendDeliveryEvent({ ...event, status: "delivered" })).toBe(true);
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("stays quiet when the receipt matched nothing or lost a race", async () => {
    for (const outcome of ["not_found", "stale"]) {
      applyEmailDeliveryStatus.mockResolvedValue({ outcome, businessId: null });
      expect(await processResendDeliveryEvent(event)).toBe(false);
    }
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("survives a write failure without failing the delivery", async () => {
    // A non-2xx here makes Resend retry and eventually disable the endpoint,
    // so one bad row must not cost every later receipt.
    applyEmailDeliveryStatus.mockRejectedValue(new Error("db down"));
    expect(await processResendDeliveryEvent(event)).toBe(false);
    expect(warn).toHaveBeenCalledWith("resend delivery apply failed", expect.objectContaining({
      providerMessageId: "re_1"
    }));
    applyEmailDeliveryStatus.mockRejectedValue("not an error");
    expect(await processResendDeliveryEvent(event)).toBe(false);
  });
});
