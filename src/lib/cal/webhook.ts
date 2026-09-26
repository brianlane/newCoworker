/**
 * Inbound Cal.com booking webhooks. The URL token is defense in depth.
 * The HMAC over the raw body, keyed by the secret we registered, is the
 * real check. A delivery we understand always answers success so Cal.com
 * does not disable the subscription.
 */
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import { verifyCalWebhookSignature } from "@/lib/cal/client";

const CAL_WEBHOOK_TRIGGERS = [
  "BOOKING_CREATED",
  "BOOKING_CANCELLED",
  "BOOKING_RESCHEDULED"
] as const;

type CalWebhookPayload = {
  triggerEvent: string;
  bookingUid: string | null;
  title: string | null;
  startTime: string | null;
  attendeeName: string | null;
  attendeeEmail: string | null;
};

function parseCalWebhookPayload(rawBody: string): CalWebhookPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const trigger = typeof root.triggerEvent === "string" ? root.triggerEvent : "";
  if (!trigger) return null;
  const payload = root.payload && typeof root.payload === "object" ? (root.payload as Record<string, unknown>) : root;
  const uid = payload.uid ?? payload.bookingId;
  const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
  const first = attendees[0] && typeof attendees[0] === "object" ? (attendees[0] as Record<string, unknown>) : {};
  return {
    triggerEvent: trigger,
    bookingUid: typeof uid === "string" || typeof uid === "number" ? String(uid) : null,
    title: typeof payload.title === "string" ? payload.title : null,
    startTime: typeof payload.startTime === "string" ? payload.startTime : null,
    attendeeName: typeof first.name === "string" ? first.name : null,
    attendeeEmail: typeof first.email === "string" ? first.email : null
  };
}

function calWebhookAccepted(payload: CalWebhookPayload): boolean {
  return (CAL_WEBHOOK_TRIGGERS as readonly string[]).includes(payload.triggerEvent);
}

export async function processCalWebhook(
  businessId: string,
  rawBody: string,
  signatureHeader: string | null,
  secret: string | null
): Promise<{ ok: true; ignored?: string } | { ok: false; reason: string }> {
  if (!secret || !verifyCalWebhookSignature(rawBody, signatureHeader, secret)) {
    return { ok: false, reason: "bad_signature" };
  }
  const payload = parseCalWebhookPayload(rawBody);
  if (!payload) return { ok: true, ignored: "unparsed" };
  if (!calWebhookAccepted(payload)) return { ok: true, ignored: payload.triggerEvent };
  await processWebhookFlowEvent(businessId, {
    source: "cal_com",
    eventId: payload.bookingUid ?? undefined,
    data: {
      trigger: payload.triggerEvent,
      booking_uid: payload.bookingUid,
      title: payload.title,
      start: payload.startTime,
      name: payload.attendeeName,
      email: payload.attendeeEmail
    }
  });
  return { ok: true };
}
