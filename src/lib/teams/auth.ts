/**
 * Bot Framework inbound authentication.
 *
 * Every Teams activity arrives with `Authorization: Bearer <JWT>`, signed by
 * Microsoft. Unlike Slack (an HMAC over the raw body with a shared secret)
 * or Telegram (an echoed secret header), this is asymmetric: the signing
 * keys live at a published JWKS endpoint and rotate.
 *
 * All of the mechanics of that live in `webhook-auth/jwks.ts`, shared with
 * Google Chat, which authenticates exactly the same way with different
 * constants. What is Teams is here: which issuer, where the keys are
 * published, which of our identifiers is the audience, and which claim
 * carries the tenant.
 */

import {
  verifyWebhookToken,
  resetWebhookJwksStateForTests,
  type WebhookTokenProvider
} from "@/lib/webhook-auth/jwks";

const TEAMS_PROVIDER: WebhookTokenProvider = {
  name: "teams",
  /** Microsoft's OpenID metadata for the Bot Framework channel. */
  source: { metadataUrl: "https://login.botframework.com/v1/.well-known/openidconfiguration" },
  /** The only issuer a channel-authenticated activity may carry. */
  issuer: "https://api.botframework.com"
};

/** Test seam; see resetWebhookJwksStateForTests for why these exist. */
export function resetTeamsJwksStateForTests(): void {
  resetWebhookJwksStateForTests();
}

type TeamsTokenClaims = {
  /** The Entra tenant the activity came from, when the token carries one. */
  tenantId: string | null;
  /** The bot's own app id, echoed back as the audience. */
  audience: string;
};

export type VerifyTeamsTokenResult =
  | { ok: true; claims: TeamsTokenClaims }
  | { ok: false; reason: string };

/**
 * Verify one inbound Bot Framework token.
 *
 * The audience is OUR Microsoft app id. Without that check a perfectly
 * valid token addressed to somebody else's bot would be accepted here.
 */
export async function verifyTeamsToken(
  authorizationHeader: string | null,
  opts: { appId?: string; now?: number } = {}
): Promise<VerifyTeamsTokenResult> {
  const appId = (opts.appId ?? process.env.MICROSOFT_APP_ID ?? "").trim();
  // Named for what is missing on THIS channel rather than the shared
  // "audience_unconfigured": an operator reading the log needs to know
  // which environment variable to go and set.
  if (!appId) return { ok: false, reason: "app_id_unconfigured" };

  const verdict = await verifyWebhookToken(TEAMS_PROVIDER, authorizationHeader, {
    audience: appId,
    now: opts.now
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  const tid = verdict.token.claims.tid;
  return {
    ok: true,
    claims: {
      tenantId: typeof tid === "string" && tid.trim() ? tid.trim() : null,
      audience: verdict.token.audience
    }
  };
}
