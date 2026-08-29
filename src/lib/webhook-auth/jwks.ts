/**
 * Verifying a webhook that authenticates with a provider-signed JWT.
 *
 * Two channels arrive this way and they differ only in their constants.
 * Microsoft Teams sends a Bot Framework token; Google Chat sends one signed
 * by `chat@system.gserviceaccount.com`. Both are RS256 over a published,
 * rotating key set, and both need the same four checks made in the same
 * order. Everything that is not a constant is here exactly once.
 *
 * WHAT A MISSED CHECK COSTS. This is the only thing standing between the
 * public internet and "a message from your team", so a token that verifies
 * must prove all four of:
 *
 *   - SIGNATURE, against a key from the provider's own published set
 *   - ISSUER, or a token minted by some other service the same provider
 *     signs for is accepted here. A provider may legitimately use more than
 *     one issuer string (Google spells its OIDC issuer both with and
 *     without a scheme), so this may be a list. Note what an issuer does
 *     NOT prove: a shared issuer like Google's OIDC endpoint signs for
 *     EVERY account it hosts, so pinning it identifies the signer's
 *     platform and not the sender. A provider on a shared issuer needs a
 *     claim check of its own on top; see google-chat/auth.ts.
 *   - AUDIENCE equal to OUR app identifier, or a valid token addressed to a
 *     DIFFERENT app is replayed into ours. A provider may mint this from
 *     more than one identifier of ours (Google Chat picks either the Cloud
 *     project number or the endpoint URL, and does not say which), so the
 *     caller may supply several. They are matched as a SET OF OURS, never
 *     as a wildcard: every candidate still has to be an identifier we own.
 *   - EXPIRY, with a small clock-skew allowance
 *
 * Deliberately no JWT library. Node's `createPublicKey` takes a JWK
 * directly, so the whole verification is a page of `node:crypto` and one
 * fewer dependency in the supply chain of an auth path.
 */

import { createPublicKey, timingSafeEqual, verify as cryptoVerify } from "crypto";
import { logger } from "@/lib/logger";

/** Keys rotate; a day of caching is the usual provider guidance. */
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;

/** Clock skew allowance on expiry, matching the Slack webhook's window. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * How often an unknown `kid` may force a key refresh.
 *
 * Without this, an unknown kid costs a fetch EVERY time, and our app
 * identifiers are public: anyone can mint a syntactically valid token with
 * the right issuer, audience and expiry, and turn a webhook into an
 * amplifier against the provider's key endpoint by varying the kid.
 * Throttled, the whole fleet spends at most one refresh per window no
 * matter how much garbage arrives, and a real rotation still recovers in
 * minutes instead of the cache's 24 hours.
 */
const FORCE_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

type Jwk = { kid?: string; kty?: string; use?: string; n?: string; e?: string };

/**
 * Where a provider's keys come from.
 *
 * `metadataUrl` is the OpenID discovery document naming a `jwks_uri`
 * (Microsoft); `jwksUrl` is a key set served directly (Google). Exactly one
 * is used, and a provider that supplies neither is a programming error
 * rather than a runtime condition.
 */
type JwksSource = { metadataUrl: string } | { jwksUrl: string };

export type WebhookTokenProvider = {
  /** Names the cache bucket and the log lines. */
  name: string;
  source: JwksSource;
  /** The only issuer(s) a token from this provider may carry. */
  issuer: string | string[];
};

type CacheEntry = {
  keys: Jwk[];
  fetchedAt: number;
  lastForcedRefreshAt: number;
  lastForcedRefreshFailed: boolean;
};

const caches = new Map<string, CacheEntry>();

/**
 * Test seam, matching resetGoogleRefreshStateForTests and friends: a
 * module-level cache needs a way to be cleared between tests, and the
 * alternative (re-importing the module per test) makes every suite that
 * touches it awkward for no gain.
 */
export function resetWebhookJwksStateForTests(): void {
  caches.clear();
}

/**
 * Returns the whole cache ENTRY rather than just the keys, so the caller
 * never has to reason about whether one exists. A successful load always
 * leaves one behind, and handing it back removes an `entry?.` that could
 * only ever be defined and would sit there forever looking like a case
 * somebody had thought about.
 */
async function loadJwks(
  provider: WebhookTokenProvider,
  now: number,
  opts: { force?: boolean } = {}
): Promise<CacheEntry> {
  const cached = caches.get(provider.name);
  if (!opts.force && cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached;

  let jwksUrl: string;
  if ("jwksUrl" in provider.source) {
    jwksUrl = provider.source.jwksUrl;
  } else {
    const configRes = await fetch(provider.source.metadataUrl);
    if (!configRes.ok) throw new Error(`openid config: http_${configRes.status}`);
    const config = (await configRes.json()) as { jwks_uri?: string };
    if (!config.jwks_uri) throw new Error("openid config: no jwks_uri");
    jwksUrl = config.jwks_uri;
  }

  const jwksRes = await fetch(jwksUrl);
  if (!jwksRes.ok) throw new Error(`jwks: http_${jwksRes.status}`);
  const jwks = (await jwksRes.json()) as { keys?: Jwk[] };
  const keys = jwks.keys ?? [];
  if (keys.length === 0) throw new Error("jwks: empty key set");

  const entry: CacheEntry = {
    keys,
    fetchedAt: now,
    lastForcedRefreshAt: cached?.lastForcedRefreshAt ?? 0,
    lastForcedRefreshFailed: cached?.lastForcedRefreshFailed ?? false
  };
  caches.set(provider.name, entry);
  return entry;
}

function base64UrlDecode(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

type VerifiedWebhookToken = {
  /** Every claim the token carried, for the channel to read what it needs. */
  claims: Record<string, unknown>;
  /** The audience, echoed back so a caller need not re-read it. */
  audience: string;
};

export type VerifyWebhookTokenResult =
  | { ok: true; token: VerifiedWebhookToken }
  | { ok: false; reason: string };

/**
 * Verify one inbound provider-signed token.
 *
 * Returns a reason rather than throwing, and callers answer 401 for every
 * one of them without distinguishing: telling an unauthenticated caller
 * WHICH check they failed is a free oracle. The one exception is
 * `jwks_unavailable`, which is OURS rather than the caller's and has to be
 * a 500 so the provider redelivers.
 */
export async function verifyWebhookToken(
  provider: WebhookTokenProvider,
  authorizationHeader: string | null,
  opts: { audience: string | string[]; now?: number }
): Promise<VerifyWebhookTokenResult> {
  const expectedAudiences = (Array.isArray(opts.audience) ? opts.audience : [opts.audience])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  // Fails CLOSED. An empty expected audience must never mean "match any",
  // and neither must a list that is empty once the blanks are dropped.
  if (expectedAudiences.length === 0) return { ok: false, reason: "audience_unconfigured" };

  const header = (authorizationHeader ?? "").trim();
  if (!/^Bearer\s+\S+$/i.test(header)) return { ok: false, reason: "malformed_header" };
  const token = header.replace(/^Bearer\s+/i, "");

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_token" };
  const [headerPart, payloadPart, signaturePart] = parts;

  let jwtHeader: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    jwtHeader = JSON.parse(base64UrlDecode(headerPart).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(payloadPart).toString("utf8"));
  } catch {
    return { ok: false, reason: "unparseable_token" };
  }

  // Pinned, not merely "whatever the header says". Accepting the token's own
  // algorithm choice is how `alg: none` and HMAC-confusion attacks work.
  if (jwtHeader.alg !== "RS256") return { ok: false, reason: "unexpected_alg" };
  const issuers = Array.isArray(provider.issuer) ? provider.issuer : [provider.issuer];
  if (typeof payload.iss !== "string" || !issuers.includes(payload.iss)) {
    return { ok: false, reason: "unexpected_issuer" };
  }

  // The audience is OUR app. Without this check a perfectly valid token
  // addressed to somebody else's app would be accepted here.
  const audience = typeof payload.aud === "string" ? payload.aud.trim() : "";
  // Every candidate is compared, with no early exit, so the work does not
  // depend on WHICH of our identifiers matched.
  let audienceMatches = false;
  for (const expected of expectedAudiences) {
    const a = Buffer.from(audience, "utf8");
    const b = Buffer.from(expected, "utf8");
    const matched = a.length === b.length && timingSafeEqual(a, b);
    audienceMatches = audienceMatches || matched;
  }
  if (!audienceMatches) return { ok: false, reason: "unexpected_audience" };

  const now = opts.now ?? Date.now();
  const exp = payload.exp;
  if (typeof exp !== "number" || exp * 1000 + CLOCK_SKEW_MS <= now) {
    return { ok: false, reason: "expired" };
  }

  let entry: CacheEntry;
  try {
    entry = await loadJwks(provider, now);
  } catch (err) {
    // A key-fetch failure is OURS, not the caller's. Reported separately so
    // the route can answer 500 and let the provider redeliver, rather than
    // 401 which would look like a rejected message and never come back.
    logger.error(`${provider.name} auth: jwks unavailable`, {
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, reason: "jwks_unavailable" };
  }

  const findKey = () => entry.keys.find((k) => k.kid === jwtHeader.kid && k.kty === "RSA");
  let jwk = findKey();
  if (!jwk) {
    /**
     * A kid we do not hold is the SIGNATURE OF A KEY ROTATION, not of a
     * forged token, and treating it as the latter is how a channel goes
     * dark for a day.
     *
     * The cache holds the provider's keys for 24 hours. When they rotate,
     * every message arrives signed by a key that is not in it. Answering
     * 401 makes the provider stop retrying, so those messages are not
     * delayed, they are LOST, and the tenant sees a coworker that simply
     * stopped replying until the cache happened to expire.
     */
    if (now - entry.lastForcedRefreshAt >= FORCE_REFRESH_COOLDOWN_MS) {
      // Stamped BEFORE the attempt, not after a success: a key endpoint
      // that is down must not be retried per request either, which is the
      // worst moment to add load to it.
      entry.lastForcedRefreshAt = now;
      entry.lastForcedRefreshFailed = false;
      try {
        entry = await loadJwks(provider, now, { force: true });
      } catch (err) {
        entry.lastForcedRefreshFailed = true;
        logger.error(`${provider.name} auth: jwks refresh failed after an unknown kid`, {
          error: err instanceof Error ? err.message : String(err)
        });
        return { ok: false, reason: "jwks_unavailable" };
      }
      jwk = findKey();
    } else if (entry.lastForcedRefreshFailed) {
      /**
       * Throttled, AND the last attempt to look failed. We do not know
       * whether this kid is real, and the two answers are not equally safe:
       * `unknown_key` becomes a 401, which makes the provider stop retrying
       * and DROPS the message, while `jwks_unavailable` becomes a 500 and
       * it comes back once the provider recovers.
       *
       * So an outage during a rotation costs a redelivery rather than a
       * lost message. A forged token gets the 500 too, which costs nothing:
       * nobody is retrying a token they made up.
       */
      return { ok: false, reason: "jwks_unavailable" };
    }
  }
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

  return { ok: true, token: { claims: payload, audience } };
}
