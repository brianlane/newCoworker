/**
 * base64url to raw bytes, for `pushManager.subscribe({ applicationServerKey })`.
 *
 * VAPID public keys travel as base64url (RFC 4648 section 5: `-` and `_`
 * instead of `+` and `/`, padding stripped). The Push API wants a
 * BufferSource, and passing the string through unconverted fails at
 * subscribe time with an opaque InvalidCharacterError, so this runs on the
 * key the moment it arrives from /api/push/vapid-key.
 *
 * Pure and browser-safe: it takes a string, returns bytes, and touches no
 * globals beyond `atob`, which exists in every browser and in Node 16+. That
 * keeps the decision out of the component and under the lib coverage gate.
 *
 * public/sw.js carries its own copy of this for the pushsubscriptionchange
 * path, because a service worker cannot import from the app bundle. The
 * duplication is eight lines and is called out in both places.
 */
/**
 * The return type is pinned to `Uint8Array<ArrayBuffer>` rather than a bare
 * `Uint8Array`. Since TypeScript 5.7 the default is `Uint8Array<ArrayBufferLike>`,
 * which includes SharedArrayBuffer and therefore does NOT satisfy the
 * `BufferSource` that `applicationServerKey` wants. Allocating the backing
 * ArrayBuffer explicitly is what makes the narrow type hold.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}
