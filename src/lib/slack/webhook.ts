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

/** A block_actions press we act on (the approval buttons). */
export type SlackInteractionAction = {
  teamId: string;
  userId: string;
  userName: string | null;
  actionId: string;
  /** The button's `value` payload, verbatim (JSON the poster chose). */
  value: string;
  responseUrl: string | null;
};

/**
 * Parse an interactivity delivery: a form-encoded body whose `payload`
 * field is JSON. Returns null for anything that is not a block_actions
 * press with at least one action (view submissions etc. are not ours yet).
 */
export function parseSlackInteractionPayload(rawBody: string): SlackInteractionAction | null {
  let payloadRaw: string | null = null;
  try {
    payloadRaw = new URLSearchParams(rawBody).get("payload");
    /* c8 ignore start -- URLSearchParams(string) does not throw today; the
       guard is for engine changes, not a reachable branch */
  } catch {
    return null;
  }
  /* c8 ignore stop */
  if (!payloadRaw) return null;
  let payload: {
    type?: unknown;
    team?: { id?: unknown };
    user?: { id?: unknown; name?: unknown; username?: unknown };
    actions?: Array<{ action_id?: unknown; value?: unknown }>;
    response_url?: unknown;
  };
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    return null;
  }
  if (payload.type !== "block_actions") return null;
  const teamId = payload.team?.id;
  const userId = payload.user?.id;
  const action = Array.isArray(payload.actions) ? payload.actions[0] : undefined;
  if (
    typeof teamId !== "string" ||
    typeof userId !== "string" ||
    !action ||
    typeof action.action_id !== "string"
  ) {
    return null;
  }
  const name = payload.user?.name ?? payload.user?.username;
  return {
    teamId,
    userId,
    userName: typeof name === "string" && name.length > 0 ? name : null,
    actionId: action.action_id,
    value: typeof action.value === "string" ? action.value : "",
    responseUrl: slackResponseUrlOrNull(payload.response_url)
  };
}

/**
 * Server-side request-forgery guard: a response_url is only ever fetched
 * when it is literally a Slack webhook endpoint. The payload is already
 * HMAC-verified, so this is defense in depth against a forged-or-buggy
 * value steering a server-side POST anywhere else.
 */
export function slackResponseUrlOrNull(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com") return null;
    // Rebuilt from validated parts, never the raw string: the fetched URL
    // is constructed against the fixed origin, so no parser quirk (or
    // future refactor) can steer the POST anywhere else.
    return `https://hooks.slack.com${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

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
