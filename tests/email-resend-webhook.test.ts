/**
 * Resend delivery webhook (src/lib/email/resend-webhook.ts).
 *
 * The signature tests carry the weight here. This endpoint can mark a
 * delivered alert as bounced, so an unsigned or replayed POST has to be
 * refused rather than merely logged.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockedApply = {
  outcome: string;
  businessId: string | null;
  send?: Record<string, unknown> | null;
};
const applyEmailDeliveryStatus = vi.fn(
  async (_input: unknown): Promise<MockedApply> => ({ outcome: "applied", businessId: null })
);
const applyEmailDeliveryStatusByRecipient = vi.fn(
  async (_input: unknown): Promise<MockedApply> => ({ outcome: "not_found", businessId: null })
);
vi.mock("@/lib/email/delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/delivery")>()),
  applyEmailDeliveryStatus: (input: unknown) => applyEmailDeliveryStatus(input),
  applyEmailDeliveryStatusByRecipient: (input: unknown) =>
    applyEmailDeliveryStatusByRecipient(input)
}));

const retireProspectsOnBounce = vi.fn(async (_input: unknown) => 0);
vi.mock("@/lib/outreach/bounce", () => ({
  retireProspectsOnBounce: (input: unknown) => retireProspectsOnBounce(input)
}));

const recordSystemLog = vi.fn(async (_input: unknown) => {});
vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: (input: unknown) => recordSystemLog(input)
}));

const notifyContactEmailBounce = vi.fn(async (_input: unknown) => ({
  outcome: "alerted" as string,
  contactE164: "+13025550100" as string | null
}));
vi.mock("@/lib/notifications/contact-email-bounce-notify", async (importOriginal) => ({
  // The source classification is the real one; only the page itself is faked.
  ...(await importOriginal<typeof import("@/lib/notifications/contact-email-bounce-notify")>()),
  notifyContactEmailBounce: (input: unknown) => notifyContactEmailBounce(input)
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
    applyEmailDeliveryStatusByRecipient.mockReset();
    applyEmailDeliveryStatusByRecipient.mockResolvedValue({
      outcome: "not_found",
      businessId: null
    });
    retireProspectsOnBounce.mockReset();
    retireProspectsOnBounce.mockResolvedValue(0);
    notifyContactEmailBounce.mockReset();
    notifyContactEmailBounce.mockResolvedValue({ outcome: "alerted", contactE164: "+13025550100" });
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
    const { message, payload } = recordSystemLog.mock.calls[0][0] as unknown as {
      message: string;
      payload: { errorMessage?: string; outreachRetired?: number };
    };
    expect(message).toContain("owner@example.com");
    expect(message).not.toContain("Mailbox does not exist");
    expect(message.toLowerCase()).not.toContain("mailing list");
    expect(payload.errorMessage).toBe("Mailbox does not exist");
    expect(payload.outreachRetired).toBe(0);
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
    expect(message).toBe("Email was not delivered (complained).");
  });

  it("stays quiet about a routine delivery", async () => {
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "applied", businessId: BIZ });
    expect(await processResendDeliveryEvent({ ...event, status: "delivered" })).toBe(true);
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("still raises a failure it could not attribute to a tenant", async () => {
    // Most Resend traffic (verification mail, provisioning notices) writes no
    // email_log row at all, and the alert path has a narrow race where an
    // instant rejection beats our own insert. A bounce must not vanish down
    // either hole just because we cannot name the tenant.
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "not_found", businessId: null });
    expect(await processResendDeliveryEvent(event)).toBe(false);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: null,
        level: "error",
        source: "email",
        event: "email_delivery_failed_unattributed"
      })
    );
    const { message } = recordSystemLog.mock.calls[0][0] as unknown as { message: string };
    expect(message).toContain("Matched no logged send.");

    // Same path with nothing to say about it still names the failure.
    recordSystemLog.mockClear();
    await processResendDeliveryEvent({ ...event, to: null, errorMessage: null });
    const second = recordSystemLog.mock.calls[0][0] as unknown as { message: string };
    expect(second.message).toBe("Email was not delivered (bounced). Matched no logged send.");
  });

  it("stays quiet about an unattributed receipt that is not a failure", async () => {
    // Resend fires for every message on the account; logging routine misses
    // would drown the fleet error feed.
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "not_found", businessId: null });
    expect(await processResendDeliveryEvent({ ...event, status: "delivered" })).toBe(false);
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("stays quiet when the receipt lost a race to a higher state", async () => {
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "stale", businessId: BIZ });
    expect(await processResendDeliveryEvent(event)).toBe(false);
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

  it("attributes a failure by recipient and subject when the provider id matches nothing", async () => {
    // The relay case: Gmail's default send-as identity hands the message to
    // smtp.resend.com, so the row holds the Gmail id and the receipt a Resend
    // UUID. The bounce still belongs to a tenant, and the feed should say so.
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "not_found", businessId: null });
    applyEmailDeliveryStatusByRecipient.mockResolvedValue({ outcome: "applied", businessId: BIZ });
    expect(await processResendDeliveryEvent(event)).toBe(true);
    expect(applyEmailDeliveryStatusByRecipient).toHaveBeenCalledWith({
      to: "owner@example.com",
      subject: "Urgent: new lead",
      status: "bounced",
      errorCode: "Permanent",
      errorMessage: "Mailbox does not exist",
      timestamp: "2026-08-26T06:00:00.000Z"
    });
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        event: "email_delivery_failed",
        payload: expect.objectContaining({ attributedBy: "recipient_subject" })
      })
    );
  });

  it("stays quiet when the fallback matched a row that already recorded this failure", async () => {
    // Same contract as a stale provider-id match: the first receipt logged
    // it, a duplicate webhook delivery must not log it twice.
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "not_found", businessId: null });
    applyEmailDeliveryStatusByRecipient.mockResolvedValue({ outcome: "stale", businessId: BIZ });
    expect(await processResendDeliveryEvent(event)).toBe(false);
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("skips the fallback when the receipt lacks a recipient or subject", async () => {
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "not_found", businessId: null });
    await processResendDeliveryEvent({ ...event, to: null });
    await processResendDeliveryEvent({ ...event, subject: null });
    expect(applyEmailDeliveryStatusByRecipient).not.toHaveBeenCalled();
    // Both still surfaced, just unattributed.
    expect(recordSystemLog).toHaveBeenCalledTimes(2);
  });

  it("does not run the fallback for a routine unattributed non-failure", async () => {
    // Resend fires sent/delivered for every unlogged message on the account
    // (verification mail, provisioning notices); querying email_log for each
    // would be a per-event tax for rows that are not there.
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "not_found", businessId: null });
    await processResendDeliveryEvent({ ...event, status: "delivered" });
    expect(applyEmailDeliveryStatusByRecipient).not.toHaveBeenCalled();
  });

  it("degrades a fallback fault to the unattributed log rather than losing the failure", async () => {
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "not_found", businessId: null });
    applyEmailDeliveryStatusByRecipient.mockRejectedValue(new Error("lookup down"));
    expect(await processResendDeliveryEvent(event)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "resend delivery recipient fallback failed",
      expect.objectContaining({ providerMessageId: "re_1", error: "lookup down" })
    );
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "email_delivery_failed_unattributed" })
    );

    applyEmailDeliveryStatusByRecipient.mockRejectedValue("not an error");
    expect(await processResendDeliveryEvent(event)).toBe(false);
  });

  it("retires a bounced outreach pitch so the day-5 nudge never fires", async () => {
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "applied", businessId: BIZ });
    await processResendDeliveryEvent(event);
    expect(retireProspectsOnBounce).toHaveBeenCalledWith({
      to: "owner@example.com",
      subject: "Urgent: new lead",
      status: "bounced",
      errorCode: "Permanent",
      errorMessage: "Mailbox does not exist",
      occurredAt: "2026-08-26T06:00:00.000Z",
      businessId: BIZ
    });
  });

  it("says the outreach follow-up was cancelled when a pitch was retired", async () => {
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "applied", businessId: BIZ });
    retireProspectsOnBounce.mockResolvedValue(1);
    await processResendDeliveryEvent(event);
    const { message, payload } = recordSystemLog.mock.calls[0][0] as unknown as {
      message: string;
      payload: { outreachRetired?: number };
    };
    expect(message).toContain("Outreach follow-up cancelled");
    expect(payload.outreachRetired).toBe(1);
  });

  it("still tries to retire when the bounce could not be attributed", async () => {
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "not_found", businessId: null });
    await processResendDeliveryEvent(event);
    expect(retireProspectsOnBounce).toHaveBeenCalledWith(
      expect.objectContaining({ to: "owner@example.com", businessId: null })
    );
  });

  it("still tries to retire when email_log itself is down", async () => {
    applyEmailDeliveryStatus.mockRejectedValue(new Error("db down"));
    await processResendDeliveryEvent(event);
    expect(retireProspectsOnBounce).toHaveBeenCalled();
  });

  it("does not retire a complaint or a delivered receipt", async () => {
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "applied", businessId: BIZ });
    await processResendDeliveryEvent({ ...event, status: "complained" });
    await processResendDeliveryEvent({ ...event, status: "delivered" });
    expect(retireProspectsOnBounce).not.toHaveBeenCalled();
  });

  it("does not fail the webhook when bounce retirement throws", async () => {
    applyEmailDeliveryStatus.mockResolvedValue({ outcome: "applied", businessId: BIZ });
    retireProspectsOnBounce.mockRejectedValue(new Error("ledger down"));
    expect(await processResendDeliveryEvent(event)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "outreach bounce retire failed",
      expect.objectContaining({ to: "owner@example.com", error: "ledger down" })
    );

    retireProspectsOnBounce.mockRejectedValue("not an error");
    expect(await processResendDeliveryEvent(event)).toBe(true);
  });

  describe("a failed send to a CONTACT is the tenant's to act on", () => {
    // The motivating case (KYP / Vantage Flow Media, 2026-09-03): a booking
    // confirmation to a lead whose booking email did not exist. The tenant is
    // the only one who can reach the lead another way; HQ can do nothing.
    const leadSend = {
      id: "log-1",
      businessId: BIZ,
      source: "tenant_mailbox_outbound",
      to: "lead@dead.example",
      subject: "Confirmed: Strategy Call with Liz",
      runId: "run-1",
      flowId: "flow-1"
    };
    const leadEvent = { ...event, to: "lead@dead.example", subject: "Confirmed: Strategy Call with Liz" };

    it("pages the owner and records the failure at warn, not error", async () => {
      applyEmailDeliveryStatus.mockResolvedValue({ outcome: "applied", businessId: BIZ, send: leadSend });
      expect(await processResendDeliveryEvent(leadEvent)).toBe(true);
      expect(notifyContactEmailBounce).toHaveBeenCalledWith({
        businessId: BIZ,
        emailLogId: "log-1",
        address: "lead@dead.example",
        subject: "Confirmed: Strategy Call with Liz",
        status: "bounced",
        errorCode: "Permanent",
        runId: "run-1",
        flowId: "flow-1"
      });
      const logged = recordSystemLog.mock.calls[0][0] as unknown as {
        level: string;
        event: string;
        message: string;
        payload: Record<string, unknown>;
      };
      expect(logged.event).toBe("email_delivery_failed");
      expect(logged.level).toBe("warn");
      expect(logged.message).toContain("The account owner was alerted");
      expect(logged.payload).toEqual(
        expect.objectContaining({
          emailLogSource: "tenant_mailbox_outbound",
          ownerAlert: "alerted",
          contactE164: "+13025550100"
        })
      );
    });

    it("treats an alert already sent inside the throttle window as handed off", async () => {
      applyEmailDeliveryStatus.mockResolvedValue({ outcome: "applied", businessId: BIZ, send: leadSend });
      notifyContactEmailBounce.mockResolvedValue({ outcome: "alerted_earlier", contactE164: "+13025550100" });
      await processResendDeliveryEvent(leadEvent);
      const logged = recordSystemLog.mock.calls[0][0] as unknown as { level: string; payload: Record<string, unknown> };
      expect(logged.level).toBe("warn");
      expect(logged.payload.ownerAlert).toBe("alerted_earlier");
    });

    it("keeps the admin error when the tenant could not be reached", async () => {
      // If no channel accepted the page, or the pager threw, the action is
      // back with HQ, and the row must say so at the level HQ reads.
      applyEmailDeliveryStatus.mockResolvedValue({ outcome: "applied", businessId: BIZ, send: leadSend });
      for (const outcome of ["not_delivered", "failed"]) {
        recordSystemLog.mockClear();
        notifyContactEmailBounce.mockResolvedValue({ outcome, contactE164: null });
        await processResendDeliveryEvent(leadEvent);
        const logged = recordSystemLog.mock.calls[0][0] as unknown as {
          level: string;
          message: string;
          payload: Record<string, unknown>;
        };
        expect(logged.level).toBe("error");
        expect(logged.message).not.toContain("owner was alerted");
        expect(logged.payload.ownerAlert).toBe(outcome);
      }
    });

    it("never echoes a bounced OWNER alert back to the tenant", async () => {
      // A `notification` row is mail TO the owner. Its bounce means the
      // owner's channel is dying, which is HQ's problem to chase, and the
      // one address we know cannot receive it is the one that just bounced.
      applyEmailDeliveryStatus.mockResolvedValue({
        outcome: "applied",
        businessId: BIZ,
        send: { ...leadSend, source: "notification", to: "owner@example.com" }
      });
      await processResendDeliveryEvent(event);
      expect(notifyContactEmailBounce).not.toHaveBeenCalled();
      const logged = recordSystemLog.mock.calls[0][0] as unknown as { level: string; payload: Record<string, unknown> };
      expect(logged.level).toBe("error");
      expect(logged.payload.emailLogSource).toBe("notification");
      expect(logged.payload).not.toHaveProperty("ownerAlert");
    });

    it("leaves an outreach pitch through the owner mailbox on the admin path", async () => {
      // HQ's pitches leave through `owner_mailbox`; the bounce path already
      // retires them, so a page would be a to-do that is already done.
      applyEmailDeliveryStatus.mockResolvedValue({
        outcome: "applied",
        businessId: BIZ,
        send: { ...leadSend, source: "owner_mailbox" }
      });
      retireProspectsOnBounce.mockResolvedValue(1);
      await processResendDeliveryEvent(leadEvent);
      expect(notifyContactEmailBounce).not.toHaveBeenCalled();
      expect((recordSystemLog.mock.calls[0][0] as unknown as { level: string }).level).toBe("error");
    });

    it("stays on the admin path when the match carried no send details", async () => {
      applyEmailDeliveryStatus.mockResolvedValue({ outcome: "applied", businessId: BIZ, send: null });
      await processResendDeliveryEvent(leadEvent);
      expect(notifyContactEmailBounce).not.toHaveBeenCalled();
      const logged = recordSystemLog.mock.calls[0][0] as unknown as { level: string; payload: Record<string, unknown> };
      expect(logged.level).toBe("error");
      expect(logged.payload.emailLogSource).toBeNull();
    });

    it("falls back to the receipt's own recipient and subject when the row lacks them", async () => {
      applyEmailDeliveryStatus.mockResolvedValue({
        outcome: "applied",
        businessId: BIZ,
        send: { ...leadSend, to: null, subject: null }
      });
      await processResendDeliveryEvent(leadEvent);
      expect(notifyContactEmailBounce).toHaveBeenCalledWith(
        expect.objectContaining({
          address: "lead@dead.example",
          subject: "Confirmed: Strategy Call with Liz"
        })
      );

      // No address anywhere means nobody to describe; no page, admin error.
      notifyContactEmailBounce.mockClear();
      recordSystemLog.mockClear();
      await processResendDeliveryEvent({ ...leadEvent, to: null });
      expect(notifyContactEmailBounce).not.toHaveBeenCalled();
      expect((recordSystemLog.mock.calls[0][0] as unknown as { level: string }).level).toBe("error");
    });

    it("pages the owner for a send matched by the recipient fallback too", async () => {
      // The relay path returns the same row shape, so a bounce attributed by
      // recipient + subject must route the same way as a provider-id match.
      applyEmailDeliveryStatus.mockResolvedValue({ outcome: "not_found", businessId: null, send: null });
      applyEmailDeliveryStatusByRecipient.mockResolvedValue({
        outcome: "applied",
        businessId: BIZ,
        send: { ...leadSend, source: "ai_flow" }
      });
      await processResendDeliveryEvent(leadEvent);
      expect(notifyContactEmailBounce).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BIZ, emailLogId: "log-1" })
      );
      const logged = recordSystemLog.mock.calls[0][0] as unknown as { level: string; payload: Record<string, unknown> };
      expect(logged.level).toBe("warn");
      expect(logged.payload.attributedBy).toBe("recipient_subject");
    });

    it("does not page anyone about a receipt that is not a failure", async () => {
      applyEmailDeliveryStatus.mockResolvedValue({ outcome: "applied", businessId: BIZ, send: leadSend });
      await processResendDeliveryEvent({ ...leadEvent, status: "delivered" });
      expect(notifyContactEmailBounce).not.toHaveBeenCalled();
      expect(recordSystemLog).not.toHaveBeenCalled();
    });
  });
});
