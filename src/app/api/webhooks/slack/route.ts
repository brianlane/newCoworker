/**
 * Slack Events API receiver.
 *
 * Every delivery is signature-verified on the RAW body BEFORE parsing
 * (HMAC-SHA256 with the app signing secret, ±5 min timestamp window), the
 * same discipline as the Meta webhook. Slack expects a 2xx within 3
 * seconds and retries at ~0/1/5 min otherwise, so handlers here stay
 * cheap and idempotent:
 *
 *   - url_verification  → echo the challenge (one-time endpoint handshake)
 *   - app_uninstalled, and tokens_revoked WHEN the payload's tokens.bot
 *     list is non-empty (a user revoking their personal grant must not
 *     wipe a healthy bot install)
 *                       → wipe the workspace's dead bot token and flip the
 *                         connection inactive (Zoom app_deauthorized
 *                         precedent). A DB failure answers 500 so Slack's
 *                         retry redelivers.
 *   - everything else   → 200 no-op for now (the chat events grow handlers
 *                         in the two-way-chat PR).
 *
 * An authentic-but-unrecognized payload answers 200, never 4xx: sustained
 * non-2xx rates make Slack disable the event subscription entirely.
 */
import { errorResponse, successResponse } from "@/lib/api-response";
import {
  parseSlackEventEnvelope,
  SLACK_WEBHOOK_MAX_BODY_BYTES,
  tokensRevokedCoversBot,
  verifySlackSignature
} from "@/lib/slack/webhook";
import { markSlackConnectionDeauthorizedByTeamId } from "@/lib/db/slack-connections";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > SLACK_WEBHOOK_MAX_BODY_BYTES) {
    return errorResponse("VALIDATION_ERROR", "payload too large (256KB max)", 413);
  }

  const verified = verifySlackSignature({
    rawBody,
    timestampHeader: request.headers.get("x-slack-request-timestamp"),
    signatureHeader: request.headers.get("x-slack-signature")
  });
  if (!verified) {
    return errorResponse("UNAUTHORIZED", "Invalid webhook signature");
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return errorResponse("VALIDATION_ERROR", "body must be JSON");
  }

  const envelope = parseSlackEventEnvelope(json);
  if (envelope === null) {
    // Authentic (signature passed) but not a shape we know. 200 so Slack
    // neither retries nor counts it against the failure budget.
    return successResponse({ ignored: true });
  }

  if (envelope.kind === "url_verification") {
    // Slack expects the raw challenge string back.
    return new Response(envelope.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    });
  }

  const { teamId, event } = envelope;
  const botDied =
    event.type === "app_uninstalled" ||
    (event.type === "tokens_revoked" && tokensRevokedCoversBot(event));
  if (botDied) {
    try {
      await markSlackConnectionDeauthorizedByTeamId(teamId);
    } catch (err) {
      logger.error("slack webhook: deauthorize write failed; asking for redelivery", {
        teamId,
        eventType: event.type,
        error: err instanceof Error ? err.message : String(err)
      });
      // 500 → Slack retries (~1 min, then ~5 min): a transient DB blip must
      // not leave a dead token looking connected.
      return errorResponse("INTERNAL_SERVER_ERROR", "retry");
    }
    return successResponse({ handled: event.type });
  }

  return successResponse({ ignored: true });
}
