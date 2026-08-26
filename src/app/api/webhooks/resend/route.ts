/**
 * Resend delivery webhook receiver.
 *
 * Resend fires one POST per lifecycle event for every email the account
 * sends (sent, delivered, delivery_delayed, bounced, complained, failed). We
 * verify the Svix signature against RESEND_WEBHOOK_SECRET, then attach the
 * receipt to the email_log row the send stored, and raise the failures as
 * system logs so they land on the admin System Errors view.
 *
 * Configure it at resend.com/webhooks pointing to
 * `<app>/api/webhooks/resend`, subscribed to the email.* events above.
 *
 * This endpoint always answers 200 for a verified delivery, even when the
 * receipt matched no row. Resend retries non-2xx and eventually disables a
 * failing endpoint, and the single most common "miss" here is entirely
 * expected: mail sent by a path that does not log to email_log at all.
 */
import { errorResponse, successResponse } from "@/lib/api-response";
import {
  parseResendWebhookBody,
  processResendDeliveryEvent,
  RESEND_WEBHOOK_MAX_BODY_BYTES,
  verifyResendWebhookSignature
} from "@/lib/email/resend-webhook";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > RESEND_WEBHOOK_MAX_BODY_BYTES) {
    return errorResponse("VALIDATION_ERROR", "payload too large (256KB max)", 413);
  }

  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) {
    // Unconfigured is not "allow everything". Until the secret is set there
    // is no way to tell a real receipt from a forged one, and a forged one
    // could mark a delivered alert as bounced.
    return errorResponse("UNAUTHORIZED", "Webhook secret not configured");
  }

  const verified = verifyResendWebhookSignature(
    rawBody,
    {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature")
    },
    secret
  );
  if (!verified) {
    return errorResponse("UNAUTHORIZED", "Invalid webhook signature");
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return errorResponse("VALIDATION_ERROR", "body must be JSON");
  }

  const event = parseResendWebhookBody(json);
  // An event type this column does not model (opens, clicks, anything Resend
  // adds later) is a successful no-op, not a rejection.
  if (!event) return successResponse({ applied: false, ignored: true });

  const applied = await processResendDeliveryEvent(event);
  return successResponse({ applied, ignored: false });
}
