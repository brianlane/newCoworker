/**
 * Signed, opaque OAuth `state` parameter, shared across first-party OAuth
 * integrations.
 *
 * The state binds an authorize redirect to the business that started it, so a
 * callback cannot be replayed against a different tenant and a stray code
 * cannot be walked in from outside the flow. It is signed rather than stored:
 * there is no server-side session to lose, and nothing to clean up.
 *
 * ## Why this module exists
 *
 * `src/lib/zoom/oauth.ts`, `src/lib/slack/oauth.ts` and `src/lib/meta/client.ts`
 * each grew their own copy of this. They agree on every security-relevant
 * detail (HMAC-SHA256, base64url payload, `payload.signature` wire format,
 * constant-time comparison, short TTL, random nonce) and differ only in a
 * domain-separation label, a TTL, and which error type they throw. Google is
 * the fourth first-party integration and Microsoft is queued behind it, so the
 * pattern is extracted here rather than copied a fourth and fifth time.
 *
 * The existing three are deliberately NOT migrated in the same change that
 * introduces this. Zoom and Slack are published, live integrations, and a
 * migration has to prove the emitted bytes are unchanged or every state minted
 * by the previous build fails to verify mid-flow. That proof deserves to be the
 * point of its own change, not a footnote in one about Google.
 *
 * ## Wire format
 *
 * `base64url(JSON) + "." + base64url(HMAC-SHA256(payload))`
 *
 * Payload keys are single letters: `b` business id, `e` expiry epoch ms, `n`
 * random nonce, then any caller-supplied extras.
 *
 * ## What actually breaks in-flight states, and what does not
 *
 * `verify` signs the payload bytes it RECEIVED and then parses them, so
 * compatibility with a state minted by an older build depends only on:
 *
 *   - the domain label, since it derives the key;
 *   - the key source (`INTEGRATIONS_ENCRYPTION_KEY`, else the service-role key);
 *   - the HMAC construction and its base64url encoding;
 *   - the `payload.signature` split on the first `.`.
 *
 * Change any of those and every state currently sitting on a provider's consent
 * screen fails on return.
 *
 * The ORDER of the payload keys is deliberately NOT in that list. It only
 * affects what `create` emits, and newly minted states are verified by the same
 * build that minted them. This was worth checking rather than assuming: moving
 * the extras ahead of the nonce leaves every captured-state test passing, which
 * is the correct outcome and not a gap in them.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** How long an authorize redirect may sit before its state is refused. */
export const DEFAULT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Derives the signing key for one integration.
 *
 * Same key source as the integration-secret envelope: a dedicated key when set,
 * else the service-role key, which is always present server-side. The `label`
 * is domain separation, so a state minted for one provider can never verify for
 * another even though both derive from the same platform secret.
 */
function stateKey(label: string, onMissingSecret: () => Error): Buffer {
  const secret =
    process.env.INTEGRATIONS_ENCRYPTION_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw onMissingSecret();
  return createHmac("sha256", label).update(secret).digest();
}

export type OAuthStateCodec<Extra extends Record<string, string> = Record<string, never>> = {
  /** Mints a signed state bound to `businessId`. */
  create: (businessId: string, extra?: Extra, now?: number) => string;
  /**
   * Verifies signature then expiry. Returns the bound business plus any extras
   * that were carried, or `null` for anything malformed, tampered, or expired.
   * Never throws on bad input: a callback is attacker-reachable, so an invalid
   * state is an expected outcome rather than an exceptional one.
   */
  verify: (state: string, now?: number) => ({ businessId: string } & Partial<Extra>) | null;
};

export type OAuthStateCodecOptions = {
  /**
   * Domain-separation label mixed into the key, e.g. `"google-oauth-state"`.
   * Changing it invalidates every state already in flight for that provider.
   */
  label: string;
  ttlMs?: number;
  /** Thrown by `create` when no signing secret is configured. */
  onMissingSecret: () => Error;
};

/**
 * Builds the create/verify pair for one integration.
 *
 * `verify` deliberately does not throw when the signing secret is missing: it
 * returns null like any other unverifiable state, so a misconfigured deploy
 * rejects callbacks rather than surfacing a stack trace on an attacker-reachable
 * path. `create` throws, because minting a state we could not sign would hand
 * the owner a redirect that can never come back.
 */
export function createOAuthStateCodec<Extra extends Record<string, string> = Record<string, never>>(
  options: OAuthStateCodecOptions
): OAuthStateCodec<Extra> {
  const ttlMs = options.ttlMs ?? DEFAULT_OAUTH_STATE_TTL_MS;

  function sign(payload: string, onMissing: () => Error): string {
    return createHmac("sha256", stateKey(options.label, onMissing))
      .update(payload)
      .digest("base64url");
  }

  return {
    create(businessId: string, extra?: Extra, now: number = Date.now()): string {
      const payload = Buffer.from(
        JSON.stringify({
          b: businessId,
          e: now + ttlMs,
          n: randomBytes(8).toString("base64url"),
          ...(extra ?? {})
        }),
        "utf8"
      ).toString("base64url");
      return `${payload}.${sign(payload, options.onMissingSecret)}`;
    },

    verify(state: string, now: number = Date.now()) {
      const dot = state.indexOf(".");
      if (dot <= 0 || dot === state.length - 1) return null;
      const payload = state.slice(0, dot);
      const sig = state.slice(dot + 1);

      let expected: string;
      try {
        expected = sign(payload, options.onMissingSecret);
      } catch {
        // No signing key: nothing can be verified, so nothing is accepted.
        return null;
      }
      const sigBuf = Buffer.from(sig, "utf8");
      const expectedBuf = Buffer.from(expected, "utf8");
      // Length check first: timingSafeEqual throws on a length mismatch, and an
      // attacker controls this length.
      if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
        return null;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      if (typeof parsed.b !== "string" || parsed.b.length === 0) return null;
      if (typeof parsed.e !== "number" || !Number.isFinite(parsed.e)) return null;
      if (parsed.e <= now) return null;

      const extras: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k === "b" || k === "e" || k === "n") continue;
        if (typeof v === "string") extras[k] = v;
      }
      return { businessId: parsed.b, ...extras } as { businessId: string } & Partial<Extra>;
    }
  };
}
