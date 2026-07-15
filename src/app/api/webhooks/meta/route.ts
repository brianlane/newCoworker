/**
 * Meta (Facebook) webhook receiver — lead ads + Messenger/Instagram DMs.
 *
 *   GET  — Meta's one-time verification handshake: echo `hub.challenge`
 *          when `hub.verify_token` matches META_WEBHOOK_VERIFY_TOKEN.
 *   POST — real-time deliveries. The raw body is verified against
 *          `X-Hub-Signature-256` (HMAC-SHA256, app secret) BEFORE parsing;
 *          everything after that lives in src/lib/meta/webhook.ts:
 *          leadgen changes become webhook flow events, conversation
 *          messages land in messenger_conversations/messages and enqueue
 *          messenger_jobs reply jobs. When a reply job was enqueued, the
 *          internal worker is kicked fire-and-forget (via `after()`) so
 *          replies land in seconds — the per-minute cron sweep is only
 *          the retry net.
 *
 * POST always answers 200 for verified deliveries — an unknown page or a
 * failed lead fetch is logged, not 4xx/5xxed, so Meta doesn't back off or
 * disable the subscription over one tenant's bad row.
 */
import { after } from "next/server";
import { errorResponse, successResponse } from "@/lib/api-response";
import { verifyMetaWebhookSignature } from "@/lib/meta/client";
import {
  META_WEBHOOK_MAX_BODY_BYTES,
  parseMetaWebhookBody,
  processMetaWebhookEvents
} from "@/lib/meta/webhook";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Fire-and-forget kick of the reply worker (same bearer the cron bridge
 * uses). Missing secret/base URL just defers to the sweep.
 */
async function kickMessengerWorker(): Promise<void> {
  const secret = process.env.INTERNAL_CRON_SECRET?.trim();
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!secret || !base) return;
  try {
    await fetch(new URL("/api/internal/messenger-worker", base).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
        Origin: base
      },
      body: "{}"
    });
  } catch (err) {
    logger.warn("messenger worker kick failed; sweep will retry", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (mode !== "subscribe" || !expected || token !== expected || challenge === null) {
    return errorResponse("UNAUTHORIZED", "Invalid verify token");
  }
  // Meta expects the raw challenge string back, not JSON.
  return new Response(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" }
  });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > META_WEBHOOK_MAX_BODY_BYTES) {
    return errorResponse("VALIDATION_ERROR", "payload too large (64KB max)", 413);
  }

  if (!verifyMetaWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    return errorResponse("UNAUTHORIZED", "Invalid webhook signature");
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return errorResponse("VALIDATION_ERROR", "body must be JSON");
  }
  const events = parseMetaWebhookBody(json);
  if (events === null) {
    return errorResponse("VALIDATION_ERROR", "body must be a Meta webhook payload");
  }

  const result = await processMetaWebhookEvents(events);
  if (result.messagesEnqueued > 0) {
    after(() => kickMessengerWorker());
  }
  return successResponse(result);
}
