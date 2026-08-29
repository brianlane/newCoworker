/**
 * Google Chat inbound authentication.
 *
 * Every event arrives with `Authorization: Bearer <JWT>` signed by Google's
 * own Chat service account. The mechanics are shared with Teams in
 * `webhook-auth/jwks.ts`; what is Google Chat is here.
 *
 * THE AUDIENCE IS THE APP'S CONFIGURED AUDIENCE, which for an HTTPS
 * endpoint is the Google Cloud project number of the project the Chat app
 * is configured in. It is the check that stops a valid token minted for
 * somebody else's Chat app being replayed at our webhook, so it fails
 * closed when unset.
 *
 * The key set is served DIRECTLY rather than through an OpenID discovery
 * document, which is the one structural difference from Teams and the
 * reason the shared source type has two shapes.
 */

import { verifyWebhookToken, type WebhookTokenProvider } from "@/lib/webhook-auth/jwks";

/** Google signs Chat events with this service account, for every app. */
const CHAT_ISSUER = "chat@system.gserviceaccount.com";

const GOOGLE_CHAT_PROVIDER: WebhookTokenProvider = {
  name: "google_chat",
  source: {
    jwksUrl: `https://www.googleapis.com/service_accounts/v1/jwk/${CHAT_ISSUER}`
  },
  issuer: CHAT_ISSUER
};

export type VerifyGoogleChatTokenResult =
  | { ok: true; audience: string }
  | { ok: false; reason: string };

export async function verifyGoogleChatToken(
  authorizationHeader: string | null,
  opts: { audience?: string; now?: number } = {}
): Promise<VerifyGoogleChatTokenResult> {
  const audience = (opts.audience ?? process.env.GOOGLE_CHAT_AUDIENCE ?? "").trim();
  // Named for what is missing on THIS channel rather than the shared
  // "audience_unconfigured": an operator reading the log needs to know
  // which environment variable to go and set.
  if (!audience) return { ok: false, reason: "audience_unconfigured" };

  const verdict = await verifyWebhookToken(GOOGLE_CHAT_PROVIDER, authorizationHeader, {
    audience,
    now: opts.now
  });
  return verdict.ok ? { ok: true, audience: verdict.token.audience } : verdict;
}
