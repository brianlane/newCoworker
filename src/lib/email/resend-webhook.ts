/**
 * Resend delivery webhook: signature verification, parsing, and dispatch.
 *
 * Resend signs with Svix. Rather than take the `svix` package for one HMAC we
 * implement the documented scheme here, the same way the Meta receiver does
 * its own X-Hub-Signature-256 check.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";
import {
  applyEmailDeliveryStatus,
  applyEmailDeliveryStatusByRecipient,
  isEmailDeliveryFailure,
  resendEventToStatus,
  type EmailDeliveryStatus
} from "@/lib/email/delivery";
import { formatEmailDeliveryFailedLogMessage } from "@/lib/email/delivery-failure-log";
import { retireProspectsOnBounce } from "@/lib/outreach/bounce";
import {
  isCustomerFacingEmailSource,
  notifyContactEmailBounce,
  type ContactEmailBounceResult
} from "@/lib/notifications/contact-email-bounce-notify";

/**
 * Reject anything larger before parsing. Resend payloads are a few KB; this
 * is the same defensive cap the Meta receiver applies.
 */
export const RESEND_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * How far a signed timestamp may be from now. Svix's own tolerance, and what
 * stops a captured-and-replayed delivery receipt from rewriting a row weeks
 * later.
 */
export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type ResendSignatureHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

/**
 * Verify a Svix-signed Resend webhook.
 *
 * The signed content is `${id}.${timestamp}.${body}`, keyed by the secret's
 * base64 payload (everything after the `whsec_` prefix), and the header holds
 * a SPACE-SEPARATED list of versioned signatures. The list matters: during a
 * secret rotation Svix sends one entry per active secret, so checking only
 * the first would drop every delivery mid-rotation.
 */
export function verifyResendWebhookSignature(
  rawBody: string,
  headers: ResendSignatureHeaders,
  secret: string,
  now: Date = new Date()
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;

  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  // Svix sends unix SECONDS. Meta's receipt path shipped a bug here by
  // treating the same unit as milliseconds, so it is spelled out rather than
  // inferred.
  const skewSeconds = Math.abs(Math.floor(now.getTime() / 1000) - timestamp);
  if (skewSeconds > RESEND_WEBHOOK_TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`, "utf8")
    .digest("base64");
  const expectedBuf = Buffer.from(expected, "utf8");

  for (const entry of headers.signature.split(" ")) {
    // Each entry is `<version>,<base64 signature>`. Only v1 is defined; an
    // unknown version is skipped rather than treated as a failure, so a
    // future scheme arriving alongside v1 does not reject the delivery.
    const [version, provided] = entry.split(",");
    if (version !== "v1" || !provided) continue;
    const providedBuf = Buffer.from(provided, "utf8");
    if (providedBuf.length !== expectedBuf.length) continue;
    if (timingSafeEqual(providedBuf, expectedBuf)) return true;
  }
  return false;
}

export type ResendDeliveryEvent = {
  status: EmailDeliveryStatus;
  providerMessageId: string;
  to: string | null;
  subject: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  occurredAt: string | null;
};

function firstRecipient(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() || null;
  if (Array.isArray(raw)) {
    const first = raw.find((v) => typeof v === "string" && v.trim());
    return typeof first === "string" ? first.trim() : null;
  }
  return null;
}

function nonEmptyString(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Parse one Resend webhook body into the receipt it carries, or null when it
 * is not one this column models.
 */
export function parseResendWebhookBody(body: unknown): ResendDeliveryEvent | null {
  if (!body || typeof body !== "object") return null;
  const envelope = body as { type?: unknown; created_at?: unknown; data?: unknown };
  if (typeof envelope.type !== "string") return null;
  const status = resendEventToStatus(envelope.type);
  if (!status) return null;

  const data = (envelope.data ?? {}) as Record<string, unknown>;
  const providerMessageId = nonEmptyString(data.email_id) ?? nonEmptyString(data.id);
  // Without the id there is no row to attach this to. Every delivery event
  // Resend documents carries one, so a miss means a shape we do not model.
  if (!providerMessageId) return null;

  // Bounce detail lives under `bounce` on a bounce and is absent otherwise.
  // `failed` puts its reason at the top level instead.
  const bounce = (data.bounce ?? {}) as Record<string, unknown>;
  // Deliberately NOT falling back to the envelope's own event type: a code
  // of "email.bounced" on a bounce is noise dressed as a classification.
  const errorCode = nonEmptyString(bounce.type) ?? nonEmptyString(bounce.subType);
  const errorMessage =
    nonEmptyString(bounce.message) ??
    nonEmptyString(data.reason) ??
    nonEmptyString((data.failed as Record<string, unknown> | undefined)?.reason);

  const occurredAtRaw = nonEmptyString(envelope.created_at) ?? nonEmptyString(data.created_at);
  const parsed = occurredAtRaw ? Date.parse(occurredAtRaw) : NaN;

  return {
    status,
    providerMessageId,
    to: firstRecipient(data.to),
    subject: nonEmptyString(data.subject),
    errorCode: isEmailDeliveryFailure(status) ? errorCode : null,
    errorMessage: isEmailDeliveryFailure(status) ? errorMessage : null,
    // An unparseable timestamp becomes null so the writer stamps `now`,
    // rather than dating the receipt to 1970 and making the failure feed
    // sort wrong.
    occurredAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  };
}

/**
 * Apply a parsed receipt and, when it is a failure, raise it where an
 * operator will see it.
 *
 * Returns whether the receipt landed on a row, so the route can stay quiet
 * about the routine misses (mail this system never logged) without hiding
 * real ones.
 */
export async function processResendDeliveryEvent(event: ResendDeliveryEvent): Promise<boolean> {
  let result: Awaited<ReturnType<typeof applyEmailDeliveryStatus>>;
  try {
    result = await applyEmailDeliveryStatus({
      providerMessageId: event.providerMessageId,
      status: event.status,
      errorCode: event.errorCode,
      errorMessage: event.errorMessage,
      timestamp: event.occurredAt
    });
  } catch (err) {
    logger.warn("resend delivery apply failed", {
      providerMessageId: event.providerMessageId,
      error: err instanceof Error ? err.message : String(err)
    });
    // The bounce still happened. Taking the prospect off the nudge queue
    // must not depend on email_log being writable in the same moment.
    await maybeRetireOutreachPitch(event, null);
    return false;
  }

  // Mail can be DELIVERED by Resend under an id our ledger never saw: HQ's
  // Gmail default send-as identity relays through smtp.resend.com, so an
  // outreach pitch is logged with its GMAIL message id while Resend delivers
  // it under a fresh UUID (see the hq-gmail-sendas-resend-relay memory; two
  // live bounces surfaced unattributed this way on 2026-08-26/28). Recipient
  // plus subject recovers those. Failures only, deliberately: Resend fires
  // for every message on the account, and running the fallback query on
  // routine unlogged traffic (verification mail, provisioning notices) would
  // hammer email_log for rows that are not there.
  let attributedByRecipient = false;
  if (result.outcome === "not_found" && isEmailDeliveryFailure(event.status)) {
    const fallback = await attributeFailureByRecipient(event);
    if (fallback) {
      result = fallback;
      attributedByRecipient = true;
    }
  }

  if (result.outcome !== "applied") {
    // A failure we could not attribute is still a failure worth seeing.
    //
    // Two ways to land here, and both matter. Most Resend traffic is sent by
    // callers that write no email_log row at all (email verification, the
    // password set, provisioning notices), so a bounce there would otherwise
    // vanish entirely. And there is a narrow race on the alert path: the send
    // returns, then we insert the row, and an instant rejection (a suppressed
    // recipient, the exact case an owner who has been bouncing lands in) can
    // fire its receipt inside that window and find nothing.
    //
    // Logged with a null business_id, which is what the fleet-wide error feed
    // is for. Deliberately failures only: Resend fires for every message on
    // the account, so logging routine misses would drown the feed.
    const retiredCount = await maybeRetireOutreachPitch(event, result.businessId);
    if (result.outcome === "not_found" && isEmailDeliveryFailure(event.status)) {
      await recordSystemLog({
        businessId: null,
        level: "error",
        source: "email",
        event: "email_delivery_failed_unattributed",
        message: formatEmailDeliveryFailedLogMessage({
          status: event.status,
          to: event.to,
          retiredCount,
          unattributed: true
        }),
        payload: {
          status: event.status,
          providerMessageId: event.providerMessageId,
          to: event.to,
          subject: event.subject,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
          outreachRetired: retiredCount
        }
      });
    }
    return false;
  }

  const retiredCount = await maybeRetireOutreachPitch(event, result.businessId);
  if (isEmailDeliveryFailure(event.status)) {
    // Who is this failure FOR? A bounced email the coworker sent to a
    // contact is the tenant's to act on (the lead typed the address; only
    // they can reach the person another way), so it is alerted to the owner
    // and recorded here at `warn`: still in the log, off the admin System
    // Errors card, which is for what HQ can act on. A bounced OWNER alert,
    // an outreach pitch, or anything we could not hand to the tenant stays
    // `error`, because then the action is ours.
    const tenantAlert = await maybeAlertTenant(event, result.send);
    const handedOff =
      tenantAlert?.outcome === "alerted" || tenantAlert?.outcome === "alerted_earlier";
    await recordSystemLog({
      businessId: result.businessId,
      level: handedOff ? "warn" : "error",
      source: "email",
      event: "email_delivery_failed",
      message: formatEmailDeliveryFailedLogMessage({
        status: event.status,
        to: event.to,
        retiredCount,
        ownerAlerted: handedOff
      }),
      payload: {
        status: event.status,
        providerMessageId: event.providerMessageId,
        to: event.to,
        subject: event.subject,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        outreachRetired: retiredCount,
        emailLogSource: result.send?.source ?? null,
        // Flagged so an operator reading the feed knows this receipt was
        // matched heuristically (recipient + subject in a recent window)
        // rather than by provider id.
        ...(attributedByRecipient ? { attributedBy: "recipient_subject" } : {}),
        ...(tenantAlert
          ? { ownerAlert: tenantAlert.outcome, contactE164: tenantAlert.contactE164 }
          : {})
      }
    });
  }
  return true;
}

/**
 * Page the tenant about a customer-facing send that failed. Null when the
 * matched send is not one the tenant should hear about (an owner alert, an
 * outreach pitch, a row with no recipient), so the caller can tell "not
 * applicable" from "tried and could not deliver". Never throws.
 */
async function maybeAlertTenant(
  event: ResendDeliveryEvent,
  send: Awaited<ReturnType<typeof applyEmailDeliveryStatus>>["send"]
): Promise<ContactEmailBounceResult | null> {
  if (!send || !isCustomerFacingEmailSource(send.source)) return null;
  const address = send.to ?? event.to;
  if (!address) return null;
  return notifyContactEmailBounce({
    businessId: send.businessId,
    emailLogId: send.id,
    address,
    subject: send.subject ?? event.subject,
    status: event.status,
    errorCode: event.errorCode,
    runId: send.runId,
    flowId: send.flowId
  });
}

/**
 * A bounced cold-outreach pitch must leave the day-5 nudge queue the moment
 * the receipt lands. The Aug 28 one-shot did this after the fact; doing it
 * here means we do not wait for an operator to re-run the script. Best-effort:
 * a fault here must not make Resend retry (and eventually disable) the
 * delivery endpoint.
 */
async function maybeRetireOutreachPitch(
  event: ResendDeliveryEvent,
  businessId: string | null
): Promise<number> {
  if (event.status !== "bounced" && event.status !== "failed") return 0;
  if (!event.to) return 0;
  try {
    return await retireProspectsOnBounce({
      to: event.to,
      subject: event.subject,
      status: event.status,
      errorCode: event.errorCode,
      errorMessage: event.errorMessage,
      occurredAt: event.occurredAt,
      businessId
    });
  } catch (err) {
    logger.warn("outreach bounce retire failed", {
      to: event.to,
      error: err instanceof Error ? err.message : String(err)
    });
    return 0;
  }
}

/**
 * The recipient+subject fallback, wrapped so its own faults can never mask
 * the failure it was trying to attribute: any error degrades to "no match"
 * and the unattributed log above still fires.
 *
 * Returns null when the receipt lacks a recipient or subject, when nothing
 * matched, or on a lookup fault; otherwise the apply outcome for the matched
 * row. A `stale` outcome is a real match (an earlier receipt already
 * recorded this failure), so the caller stays quiet exactly as it does for a
 * stale provider-id match.
 */
async function attributeFailureByRecipient(
  event: ResendDeliveryEvent
): Promise<
  | (Awaited<ReturnType<typeof applyEmailDeliveryStatus>> & { outcome: "applied" | "stale" })
  | null
> {
  if (!event.to || !event.subject) return null;
  try {
    const fallback = await applyEmailDeliveryStatusByRecipient({
      to: event.to,
      subject: event.subject,
      status: event.status,
      errorCode: event.errorCode,
      errorMessage: event.errorMessage,
      timestamp: event.occurredAt
    });
    if (fallback.outcome === "not_found") return null;
    return { ...fallback, outcome: fallback.outcome };
  } catch (err) {
    logger.warn("resend delivery recipient fallback failed", {
      providerMessageId: event.providerMessageId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
