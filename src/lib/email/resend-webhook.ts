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
  isEmailDeliveryFailure,
  resendEventToStatus,
  type EmailDeliveryStatus
} from "@/lib/email/delivery";

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
    return false;
  }

  if (result.outcome !== "applied") return false;

  if (isEmailDeliveryFailure(event.status)) {
    await recordSystemLog({
      businessId: result.businessId,
      level: "error",
      source: "email",
      event: "email_delivery_failed",
      message:
        `Email was not delivered (${event.status})` +
        (event.to ? ` to ${event.to}` : "") +
        (event.errorMessage ? `: ${event.errorMessage}` : ""),
      payload: {
        status: event.status,
        providerMessageId: event.providerMessageId,
        to: event.to,
        subject: event.subject,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage
      }
    });
  }
  return true;
}
