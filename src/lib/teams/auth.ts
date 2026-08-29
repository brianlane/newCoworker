/**
 * Bot Framework inbound authentication.
 *
 * Every Teams activity arrives with `Authorization: Bearer <JWT>`, signed by
 * Microsoft. Unlike Slack (an HMAC over the raw body with a shared secret)
 * or Telegram (an echoed secret header), this is asymmetric: the signing
 * keys live at a published JWKS endpoint and rotate, so verification means
 * fetching them, caching them, and checking the token properly.
 *
 * WHAT A MISSED CHECK COSTS. This endpoint is the only thing standing
 * between the public internet and "a message from your team". A token that
 * verifies must therefore prove all four of:
 *
 *   - SIGNATURE, against a key from Microsoft's own JWKS
 *   - ISSUER, or a token minted by some other Microsoft-signed service is
 *     accepted here
 *   - AUDIENCE equal to OUR Microsoft app id, or a valid token addressed to
 *     a DIFFERENT bot would be replayed into ours
 *   - EXPIRY, with a small clock-skew allowance
 *
 * Deliberately no JWT library: Node's `createPublicKey` takes a JWK
 * directly, so the whole verification is ~40 lines of `node:crypto` and one
 * fewer dependency in the supply chain of an auth path.
 */

import { createPublicKey, timingSafeEqual, verify as cryptoVerify } from "crypto";
import { logger } from "@/lib/logger";

/** Microsoft's OpenID metadata for the Bot Framework channel. */
const OPENID_CONFIG_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";

/** The only issuer a channel-authenticated activity may carry. */
const EXPECTED_ISSUER = "https://api.botframework.com";

/** Keys rotate; a day of caching is Microsoft's own guidance. */
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;

/** Clock skew allowance on expiry, matching the Slack webhook's window. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

type Jwk = { kid?: string; kty?: string; use?: string; n?: string; e?: string };

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

/**
 * Test seam, matching resetGoogleRefreshStateForTests and friends: a
 * module-level cache needs a way to be cleared between tests, and the
 * alternative (re-importing the module per test) makes every suite that
 * touches it awkward for no gain.
 */
export function resetTeamsJwksStateForTests(): void {
  jwksCache = null;
}

async function loadJwks(now: number): Promise<Jwk[]> {
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;

  const configRes = await fetch(OPENID_CONFIG_URL);
  if (!configRes.ok) throw new Error(`openid config: http_${configRes.status}`);
  const config = (await configRes.json()) as { jwks_uri?: string };
  if (!config.jwks_uri) throw new Error("openid config: no jwks_uri");

  const jwksRes = await fetch(config.jwks_uri);
  if (!jwksRes.ok) throw new Error(`jwks: http_${jwksRes.status}`);
  const jwks = (await jwksRes.json()) as { keys?: Jwk[] };
  const keys = jwks.keys ?? [];
  if (keys.length === 0) throw new Error("jwks: empty key set");

  jwksCache = { keys, fetchedAt: now };
  return keys;
}

function base64UrlDecode(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
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
 * Returns a reason rather than throwing, and the caller answers 401 for
 * every one of them without distinguishing: telling an unauthenticated
 * caller WHICH check they failed is a free oracle.
 */
export async function verifyTeamsToken(
  authorizationHeader: string | null,
  opts: { appId?: string; now?: number } = {}
): Promise<VerifyTeamsTokenResult> {
  const appId = (opts.appId ?? process.env.MICROSOFT_APP_ID ?? "").trim();
  if (!appId) return { ok: false, reason: "app_id_unconfigured" };

  const header = (authorizationHeader ?? "").trim();
  if (!/^Bearer\s+\S+$/i.test(header)) return { ok: false, reason: "malformed_header" };
  const token = header.replace(/^Bearer\s+/i, "");

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_token" };
  const [headerPart, payloadPart, signaturePart] = parts;

  let jwtHeader: { alg?: string; kid?: string };
  let payload: { iss?: string; aud?: string; exp?: number; tid?: string; serviceurl?: string };
  try {
    jwtHeader = JSON.parse(base64UrlDecode(headerPart).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(payloadPart).toString("utf8"));
  } catch {
    return { ok: false, reason: "unparseable_token" };
  }

  // Pinned, not merely "whatever the header says". Accepting the token's own
  // algorithm choice is how `alg: none` and HMAC-confusion attacks work.
  if (jwtHeader.alg !== "RS256") return { ok: false, reason: "unexpected_alg" };
  if (payload.iss !== EXPECTED_ISSUER) return { ok: false, reason: "unexpected_issuer" };

  // The audience is OUR app id. Without this check a perfectly valid token
  // addressed to somebody else's bot would be accepted here.
  const audience = (payload.aud ?? "").trim();
  const a = Buffer.from(audience, "utf8");
  const b = Buffer.from(appId, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "unexpected_audience" };
  }

  const now = opts.now ?? Date.now();
  if (typeof payload.exp !== "number" || payload.exp * 1000 + CLOCK_SKEW_MS <= now) {
    return { ok: false, reason: "expired" };
  }

  let keys: Jwk[];
  try {
    keys = await loadJwks(now);
  } catch (err) {
    // A key-fetch failure is OURS, not the caller's. Reported separately so
    // the route can answer 500 and let Microsoft redeliver, rather than 401
    // which would look like a rejected token and never come back.
    logger.error("teams auth: jwks unavailable", {
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, reason: "jwks_unavailable" };
  }

  const jwk = keys.find((k) => k.kid === jwtHeader.kid && k.kty === "RSA");
  if (!jwk) return { ok: false, reason: "unknown_key" };

  let verified = false;
  try {
    const key = createPublicKey({ key: jwk as never, format: "jwk" });
    verified = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${payloadPart}`, "utf8"),
      key,
      base64UrlDecode(signaturePart)
    );
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (!verified) return { ok: false, reason: "bad_signature" };

  return {
    ok: true,
    claims: { tenantId: payload.tid?.trim() || null, audience }
  };
}
