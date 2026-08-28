/**
 * The JSON contract between the dispatcher and `public/sw.js`.
 *
 * This module is the single home for the field names the service worker
 * reads. The worker is plain JS with no typechecker, so nothing can prove at
 * build time that it and the producer agree; `tests/service-worker-contract`
 * closes that by parsing the real output of `buildPushPayload` and asserting
 * the worker reads exactly these keys and no others.
 */

/**
 * RFC 8291 caps an aes128gcm push record at 4096 bytes, and the encryption
 * overhead (16-byte salt, key id, 16-byte auth tag, padding) eats roughly a
 * hundred of those. 3800 leaves comfortable headroom, and a body clamped a
 * little short is invisible next to a push the service rejects with 413.
 */
const PUSH_PAYLOAD_MAX_BYTES = 3800;

type PushPayload = {
  title: string;
  body: string;
  /** Internal dashboard path the tap opens. Always app-relative. */
  url: string;
  /** The `notifications` row this push is about, for the click receipt. */
  notificationId?: string;
  /** Collapse key, so a re-alert about the same contact replaces the old banner. */
  tag?: string;
};

export type BuildPushPayloadInput = {
  title: string;
  body: string;
  url: string;
  notificationId?: string;
  tag?: string;
};

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Trim to a BYTE budget without splitting a multi-byte character.
 *
 * Slicing by `.length` is wrong here twice over: a UTF-8 character can be up
 * to four bytes, so a character budget under-fills a Latin body and
 * overflows a CJK one; and cutting mid-sequence would put a lone surrogate in
 * the JSON. Walking Array.from gives whole code points.
 */
function clampToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const ellipsis = "...";
  const budget = Math.max(0, maxBytes - byteLength(ellipsis));
  let out = "";
  let used = 0;
  for (const char of Array.from(value)) {
    const size = byteLength(char);
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return `${out}${ellipsis}`;
}

/**
 * Force a tap target to stay inside the app.
 *
 * The worker hands this to `clients.openWindow`, so an absolute URL here
 * would let a notification navigate the owner off-site. "Starts with /" is
 * not enough on its own: "//evil.example.com" is a protocol-relative URL
 * browsers resolve against another origin, which is the same rule
 * `notificationLink` applies in src/lib/notifications/display.ts.
 */
function internalPath(url: string): string {
  const trimmed = url.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return "/dashboard";
  return trimmed;
}

/**
 * Build the payload string the push service carries and the worker parses.
 *
 * The title is clamped hard and the body absorbs whatever budget is left,
 * because a truncated title reads as broken while a truncated body reads as
 * a summary.
 */
export function buildPushPayload(input: BuildPushPayloadInput): string {
  const title = clampToBytes(input.title.trim() || "New Coworker", 120);
  const url = internalPath(input.url);

  const envelope: PushPayload = {
    title,
    body: "",
    url,
    ...(input.notificationId ? { notificationId: input.notificationId } : {}),
    ...(input.tag ? { tag: clampToBytes(input.tag, 64) } : {})
  };

  // Spend the remaining budget on the body: serialize the envelope with an
  // empty body first, then give the body everything that is left. JSON
  // escaping can expand a character, so measure the encoded result rather
  // than the raw string.
  const overhead = byteLength(JSON.stringify(envelope));
  const bodyBudget = Math.max(0, PUSH_PAYLOAD_MAX_BYTES - overhead);
  const rawBody = input.body.trim();
  // JSON.stringify of the body tells us its true encoded cost including
  // escapes; clamp against the raw string but budget with the escaped size.
  const escapedOverhead = byteLength(JSON.stringify(rawBody)) - byteLength(rawBody);
  envelope.body = clampToBytes(rawBody, Math.max(0, bodyBudget - escapedOverhead));

  return JSON.stringify(envelope);
}
