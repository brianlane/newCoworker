/**
 * Meta `signed_request` parsing and verification.
 *
 * Two Meta app callbacks POST a form-encoded `signed_request` instead of the
 * JSON + `X-Hub-Signature-256` shape the webhook callback uses: the
 * Deauthorize callback (the person removed our app) and the Data Deletion
 * Request callback (the person asked us to delete what Facebook gave us).
 * Both are answered by src/app/api/webhooks/meta/*.
 *
 * Wire format is `<base64url signature>.<base64url payload>`, and the
 * signature covers the RAW payload SEGMENT, not the decoded JSON. Re-encoding
 * the decoded object and hashing that would fail on any difference in key
 * order or whitespace, so the payload string is verified exactly as received.
 *
 * The decoded payload identifies the person by `user_id`: an APP-SCOPED id
 * (ASID), unique to this person on this app and to no other app. It is the
 * only handle we get, which is why meta_connections stores one
 * (`meta_user_id`) for these callbacks to join on.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getMetaAppSecret } from "@/lib/meta/client";

/** The fields Meta documents on the payload; extras are ignored. */
export type MetaSignedRequestPayload = {
  algorithm: string;
  /** App-scoped id of the person the request is about. */
  user_id: string;
  issued_at?: number;
  expires?: number;
};

/** The only algorithm Meta signs these with, and the only one we accept. */
const REQUIRED_ALGORITHM = "HMAC-SHA256";

function base64UrlToBuffer(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/**
 * Verify and decode a `signed_request`. Returns null for ANY problem:
 * malformed shape, bad signature, wrong algorithm, unparseable JSON, or a
 * missing user id. Callers must treat null as "refuse", never as "empty".
 *
 * Null rather than throw because both callers answer Meta on every path and
 * an exception would be indistinguishable from a bug in the handler.
 */
export function verifyMetaSignedRequest(
  signedRequest: string | null | undefined
): MetaSignedRequestPayload | null {
  if (!signedRequest) return null;

  // Exactly two segments. A payload cannot contain "." (base64url has no
  // such character), so a third segment means the input is not ours.
  const parts = signedRequest.split(".");
  if (parts.length !== 2) return null;
  const [encodedSig, encodedPayload] = parts;
  if (!encodedSig || !encodedPayload) return null;

  const expected = createHmac("sha256", getMetaAppSecret())
    .update(encodedPayload, "utf8")
    .digest();
  const provided = base64UrlToBuffer(encodedSig);
  // timingSafeEqual throws on a length mismatch, so check length first. A
  // wrong length is already a failed signature.
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlToBuffer(encodedPayload).toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const payload = parsed as Record<string, unknown>;
  // Signature verified is not the same as algorithm agreed. Pin it so a
  // future Meta change to a weaker algorithm cannot be accepted silently.
  if (payload.algorithm !== REQUIRED_ALGORITHM) return null;

  // Meta sends user_id as a numeric string; tolerate a number defensively.
  const rawUserId = payload.user_id;
  const userId =
    typeof rawUserId === "string"
      ? rawUserId
      : typeof rawUserId === "number"
        ? String(rawUserId)
        : "";
  if (!userId) return null;

  return {
    algorithm: REQUIRED_ALGORITHM,
    user_id: userId,
    ...(typeof payload.issued_at === "number" ? { issued_at: payload.issued_at } : {}),
    ...(typeof payload.expires === "number" ? { expires: payload.expires } : {})
  };
}

/**
 * Pull `signed_request` out of a request body. Meta posts it form-encoded,
 * but accept JSON too: the App Dashboard's own test tooling has been seen
 * sending JSON, and reading both costs nothing.
 */
export function readSignedRequestField(rawBody: string, contentType: string | null): string | null {
  if (contentType?.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawBody) as { signed_request?: unknown };
      return typeof parsed?.signed_request === "string" ? parsed.signed_request : null;
    } catch {
      return null;
    }
  }
  const value = new URLSearchParams(rawBody).get("signed_request");
  return value && value.length > 0 ? value : null;
}
