/**
 * Google Chat inbound authentication.
 *
 * Every event arrives with `Authorization: Bearer <JWT>` signed by Google's
 * own Chat service account. The mechanics are shared with Teams in
 * `webhook-auth/jwks.ts`; what is Google Chat is here.
 *
 * THE AUDIENCE IS THE APP'S CONFIGURED AUDIENCE, and Google offers two
 * shapes for it: the Cloud project number, or the endpoint URL Chat posts
 * to. Which one a token carries is set by an "Authentication Audience"
 * option that does NOT appear on the configuration page of an app built in
 * the Workspace add-on shape, so it cannot be read off before the first
 * event arrives, and guessing wrong rejects every event with a 401 that
 * looks exactly like a forged token.
 *
 * So this accepts a COMMA-SEPARATED LIST and matches any member. That is
 * not a loosening: each entry still has to be an identifier of ours, and
 * the check it performs is unchanged, which is what stops a valid token
 * minted for somebody else's Chat app being replayed at our webhook. It
 * fails closed when unset.
 *
 * The key set is served DIRECTLY rather than through an OpenID discovery
 * document, which is the one structural difference from Teams and the
 * reason the shared source type has two shapes.
 */

import { verifyWebhookToken, type WebhookTokenProvider } from "@/lib/webhook-auth/jwks";

/** Google signs Chat events with this service account, for every app. */
const CHAT_ISSUER = "chat@system.gserviceaccount.com";

/**
 * Shape 1, the self-signed JWT, sent when the audience is the project
 * number. Chat signs it as itself, so the issuer IS the identity.
 */
const GOOGLE_CHAT_PROVIDER: WebhookTokenProvider = {
  name: "google_chat",
  source: {
    jwksUrl: `https://www.googleapis.com/service_accounts/v1/jwk/${CHAT_ISSUER}`
  },
  issuer: CHAT_ISSUER
};

/**
 * Shape 2, an OpenID Connect ID token, sent when the audience is the app
 * URL. Different issuer, different key set, and a DIFFERENT SECURITY
 * PROPERTY that is the whole reason this constant is not just another
 * entry in the list above.
 *
 * `accounts.google.com` signs for every account Google hosts, and the
 * audience of an ID token is chosen by whoever asks for one: any service
 * account anywhere can mint a token whose `aud` is our webhook URL. So a
 * valid signature here proves only that GOOGLE minted it, never that CHAT
 * did, and accepting this shape on signature and audience alone would hand
 * a forgery to anybody with a Cloud project.
 *
 * What identifies Chat in this shape is the `email` claim, which is why
 * `verifyGoogleChatToken` refuses to return ok for it until that claim has
 * been checked. Both spellings of the issuer are accepted because Google
 * has used each.
 */
const GOOGLE_CHAT_ID_TOKEN_PROVIDER: WebhookTokenProvider = {
  name: "google_chat_id_token",
  source: { jwksUrl: "https://www.googleapis.com/oauth2/v3/certs" },
  issuer: ["https://accounts.google.com", "accounts.google.com"]
};

export type VerifyGoogleChatTokenResult =
  | { ok: true; audience: string }
  | { ok: false; reason: string };

export async function verifyGoogleChatToken(
  authorizationHeader: string | null,
  opts: { audience?: string; now?: number } = {}
): Promise<VerifyGoogleChatTokenResult> {
  const audiences = (opts.audience ?? process.env.GOOGLE_CHAT_AUDIENCE ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  // Named for what is missing on THIS channel rather than the shared
  // "audience_unconfigured": an operator reading the log needs to know
  // which environment variable to go and set.
  if (audiences.length === 0) return { ok: false, reason: "audience_unconfigured" };

  const selfSigned = await verifyWebhookToken(GOOGLE_CHAT_PROVIDER, authorizationHeader, {
    audience: audiences,
    now: opts.now
  });
  if (selfSigned.ok) return { ok: true, audience: selfSigned.token.audience };
  // Only a mismatched ISSUER means "this might be the other shape". Every
  // other refusal (malformed, expired, wrong audience, bad signature, keys
  // unavailable) is the same verdict for both, so it is returned as-is
  // rather than spending a second key fetch to reach it again.
  if (selfSigned.reason !== "unexpected_issuer") return selfSigned;

  const idToken = await verifyWebhookToken(GOOGLE_CHAT_ID_TOKEN_PROVIDER, authorizationHeader, {
    audience: audiences,
    now: opts.now
  });
  if (!idToken.ok) return idToken;

  // THE SIGNATURE PROVED GOOGLE, NOT CHAT. Anyone with a service account
  // can have Google mint a correctly signed ID token for any audience they
  // name, so without this the app URL audience would be forgeable by the
  // whole of Google Cloud. `email_verified` is required alongside it
  // because an unverified email claim asserts nothing.
  const claims = idToken.token.claims;
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";
  if (email !== CHAT_ISSUER || !emailVerified) {
    return { ok: false, reason: "unexpected_chat_identity" };
  }
  return { ok: true, audience: idToken.token.audience };
}
