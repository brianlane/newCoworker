/**
 * Validation for a browser-supplied Web Push subscription.
 *
 * Pure: no database, no network, no browser globals. The component reads
 * `PushSubscription.toJSON()` and hands the plain object here.
 */

import { z } from "zod";

/**
 * Push services whose endpoints we are willing to POST to.
 *
 * THIS IS AN SSRF GUARD, not tidiness. `endpoint` arrives from the client and
 * the server then makes an authenticated POST to it. Without an allowlist, a
 * signed-in owner can register `http://169.254.169.254/latest/meta-data/` (or
 * any internal address) and read our response status back out through the
 * delivery result, turning an alert channel into a port scanner that runs
 * inside our network.
 *
 * Exact hosts, plus dot-anchored suffixes for the services that shard by
 * region. The leading dot is what makes `fcm.googleapis.com.evil.test` fail:
 * it does not equal any exact host and it does not end with any suffix.
 */
const EXACT_PUSH_HOSTS: ReadonlySet<string> = new Set([
  "fcm.googleapis.com",
  "web.push.apple.com",
  "updates.push.services.mozilla.com"
]);

const PUSH_HOST_SUFFIXES: readonly string[] = [
  ".push.services.mozilla.com",
  ".notify.windows.com",
  ".push.apple.com"
];

/** Longest endpoint we will store. The RFC sets no ceiling; the column does. */
const MAX_ENDPOINT_LENGTH = 2048;

function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  // https only: a push endpoint is never plaintext, and allowing http: would
  // re-open the internal-address hole the allowlist exists to close.
  if (url.protocol !== "https:") return false;
  // `https://fcm.googleapis.com@evil.test/` has hostname evil.test, but a
  // careless reader (and some naive parsers) see the allowlisted host first.
  if (url.username.length > 0 || url.password.length > 0) return false;
  const host = url.hostname.toLowerCase();
  if (EXACT_PUSH_HOSTS.has(host)) return true;
  return PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * The shape `PushSubscription.toJSON()` produces. `expirationTime` is
 * accepted and ignored: no push service populates it in practice, and the
 * authoritative expiry signal is a 404/410 at send time.
 */
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().min(1).max(MAX_ENDPOINT_LENGTH).refine(isAllowedPushEndpoint, {
    message: "Unsupported push service endpoint"
  }),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    /** RFC 8291 client public key, base64url, 65 bytes uncompressed P-256. */
    p256dh: z.string().min(1).max(255),
    /** RFC 8291 auth secret, base64url, 16 bytes. */
    auth: z.string().min(1).max(255)
  })
});

export type ParsedPushSubscription = z.infer<typeof pushSubscriptionSchema>;

/**
 * A coarse, human-readable device name for the "your devices" list.
 *
 * Deliberately blunt. This is a label an owner reads to answer "which of my
 * devices is this?", not analytics, so it resolves to a handful of buckets
 * and never stores a full user-agent interpretation.
 */
export function deviceLabelFromUserAgent(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (ua.length === 0) return "Unknown device";

  const isIpad = ua.includes("iPad");
  const isIphone = ua.includes("iPhone");
  const isAndroid = ua.includes("Android");
  // Chrome and Edge both claim Safari in their UA, so Safari is what is left
  // after ruling the others out.
  const isEdge = ua.includes("Edg/");
  const isChrome = !isEdge && (ua.includes("Chrome/") || ua.includes("CriOS"));
  const isFirefox = ua.includes("Firefox/") || ua.includes("FxiOS");
  const isSafari = !isEdge && !isChrome && !isFirefox && ua.includes("Safari");

  const browser = isEdge
    ? "Edge"
    : isChrome
      ? "Chrome"
      : isFirefox
        ? "Firefox"
        : isSafari
          ? "Safari"
          : "Browser";

  if (isIphone) return `iPhone ${browser}`;
  if (isIpad) return `iPad ${browser}`;
  if (isAndroid) return `Android ${browser}`;
  if (ua.includes("Macintosh")) return `${browser} on Mac`;
  if (ua.includes("Windows")) return `${browser} on Windows`;
  if (ua.includes("Linux")) return `${browser} on Linux`;
  return browser;
}
