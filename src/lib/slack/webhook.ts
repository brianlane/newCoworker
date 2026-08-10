/**
 * Slack webhook verification + envelope parsing (Events API and, later, the
 * interactivity endpoint). Pure functions over the RAW request body so the
 * route can verify BEFORE parsing, same discipline as
 * verifyMetaWebhookSignature (src/lib/meta/client.ts).
 *
 * Slack signs every delivery with the app SIGNING SECRET (not the client
 * secret): X-Slack-Signature = "v0=" + HMAC-SHA256(signingSecret,
 * "v0:{X-Slack-Request-Timestamp}:{rawBody}"). Deliveries older than 5
 * minutes are refused to keep a captured request from being replayable.
 */
import { createHmac, timingSafeEqual } from "crypto";

/** Slack event payloads are small; anything bigger than this is not Slack. */
export const SLACK_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/** Reject deliveries whose timestamp skews more than this from our clock. */
export const SLACK_SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

export function verifySlackSignature(input: {
  rawBody: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  signingSecret?: string;
  now?: number;
}): boolean {
  const secret = input.signingSecret ?? process.env.SLACK_SIGNING_SECRET;
  if (!secret || !input.timestampHeader || !input.signatureHeader) return false;

  const timestampSec = Number(input.timestampHeader);
  if (!Number.isFinite(timestampSec)) return false;
  const skew = Math.abs((input.now ?? Date.now()) - timestampSec * 1000);
  if (skew > SLACK_SIGNATURE_MAX_SKEW_MS) return false;

  const expected = `v0=${createHmac("sha256", secret)
    .update(`v0:${input.timestampHeader}:${input.rawBody}`)
    .digest("hex")}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(input.signatureHeader, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The inner event shapes PR 1 acts on; later PRs extend this union. */
export type SlackInboundEvent =
  | { type: "app_uninstalled" }
  | { type: "tokens_revoked"; tokens?: { oauth?: unknown; bot?: unknown } }
  | { type: string; [key: string]: unknown };

/**
 * A `tokens_revoked` delivery separates revoked USER OAuth tokens
 * (`tokens.oauth`) from revoked BOT tokens (`tokens.bot`). Only the latter
 * kills the workspace install this integration tracks: a member revoking
 * their personal grant must not wipe a healthy bot connection. Fails closed
 * on a malformed payload (no bot list → not a bot revocation).
 */
export function tokensRevokedCoversBot(event: SlackInboundEvent): boolean {
  if (event.type !== "tokens_revoked") return false;
  const tokens = (event as { tokens?: unknown }).tokens;
  if (typeof tokens !== "object" || tokens === null) return false;
  const bot = (tokens as { bot?: unknown }).bot;
  return Array.isArray(bot) && bot.length > 0;
}

export type SlackEventEnvelope =
  | { kind: "url_verification"; challenge: string }
  | {
      kind: "event_callback";
      teamId: string;
      eventId: string | null;
      event: SlackInboundEvent;
    };

/**
 * Parse a verified Events API body into the two envelope kinds we handle.
 * Returns null when the JSON is not a Slack event envelope (the route
 * answers 200 anyway: an unrecognized-but-authentic delivery must not make
 * Slack retry, back off, or disable the subscription).
 */
export function parseSlackEventEnvelope(json: unknown): SlackEventEnvelope | null {
  if (typeof json !== "object" || json === null) return null;
  const body = json as {
    type?: unknown;
    challenge?: unknown;
    team_id?: unknown;
    event_id?: unknown;
    event?: unknown;
  };

  if (body.type === "url_verification") {
    if (typeof body.challenge !== "string" || body.challenge.length === 0) return null;
    return { kind: "url_verification", challenge: body.challenge };
  }

  if (body.type === "event_callback") {
    if (typeof body.team_id !== "string" || body.team_id.length === 0) return null;
    const event = body.event;
    if (typeof event !== "object" || event === null) return null;
    const type = (event as { type?: unknown }).type;
    if (typeof type !== "string" || type.length === 0) return null;
    return {
      kind: "event_callback",
      teamId: body.team_id,
      eventId: typeof body.event_id === "string" ? body.event_id : null,
      event: event as SlackInboundEvent
    };
  }

  return null;
}
