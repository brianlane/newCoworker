/**
 * VAPID key material for Web Push, resolved from env at call time.
 *
 * Resolved per call rather than captured at module load so a key rotation
 * takes effect on the next request instead of the next cold start, and so a
 * test can set the env without re-importing the module.
 *
 * The public half is served to browsers by /api/push/vapid-key rather than
 * baked in as NEXT_PUBLIC_VAPID_PUBLIC_KEY. That is not a style preference.
 * A build-time public key can SKEW from the server's private key (a rotation
 * applied to the environment without a redeploy, a preview built before the
 * var existed, a var set for Production but not Preview), and the symptom is
 * that every subscription minted by that build is permanently undeliverable:
 * the push service answers 403 forever and nothing on the client can tell,
 * because the client believes it has a key. Serving it from a route makes
 * both halves come from one process reading one env pair at one moment, so
 * they cannot skew, and it is what makes the 403 recovery path in
 * `sendWebPush` possible at all.
 */

type VapidKeys = {
  publicKey: string;
  privateKey: string;
  /** Contact URI the push service can reach us at, per RFC 8292. */
  subject: string;
};

/**
 * All three or nothing. A partial configuration is treated as unconfigured
 * rather than half-working, so a misconfigured preview refuses to mint
 * subscriptions instead of minting dead ones.
 */
export function vapidKeysFromEnv(): VapidKeys | null {
  const publicKey = (process.env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY ?? "").trim();
  const subject = (process.env.VAPID_SUBJECT ?? "").trim();
  if (publicKey.length === 0 || privateKey.length === 0 || subject.length === 0) return null;
  // RFC 8292 allows mailto: or an https: contact URI. web-push rejects
  // anything else at send time, which would turn a config typo into a
  // per-dispatch failure instead of a startup-visible one.
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) return null;
  return { publicKey, privateKey, subject };
}

/** The half browsers need for `pushManager.subscribe({ applicationServerKey })`. */
export function publicVapidKey(): string | null {
  return vapidKeysFromEnv()?.publicKey ?? null;
}
