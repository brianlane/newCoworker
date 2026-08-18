/**
 * POST /api/webhooks/meta/deauthorize — Meta's Deauthorize callback.
 *
 * Meta calls this when a person removes New Coworker from their Facebook
 * account (Settings & Privacy → Settings → Apps and Websites). Register the
 * URL in the App Dashboard under Facebook Login → Settings → "Deauthorize
 * callback URL".
 *
 * Authentication is the `signed_request` HMAC and nothing else: this is a
 * public, unauthenticated endpoint by Meta's design, so the signature check
 * in src/lib/meta/signed-request.ts is the whole security boundary. It lives
 * under /api/webhooks/ so the CSRF gate in src/proxy.ts exempts it, same as
 * the main Meta webhook.
 *
 * ALWAYS answers 200. Meta does not retry this callback and treats a non-200
 * as a broken integration, so a bad signature is logged and swallowed rather
 * than surfaced as an error status. Nothing is severed on a bad signature.
 */
import { verifyMetaSignedRequest, readSignedRequestField } from "@/lib/meta/signed-request";
import { deauthorizeMetaUser } from "@/lib/meta/deauthorize";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text().catch(() => "");
  const signedRequest = readSignedRequestField(rawBody, request.headers.get("content-type"));
  const payload = verifyMetaSignedRequest(signedRequest);

  if (!payload) {
    // Forged, malformed, or not from our app. Never act on it.
    logger.warn("meta deauthorize callback rejected", {
      hasField: Boolean(signedRequest)
    });
    return Response.json({ ok: false }, { status: 200 });
  }

  try {
    const result = await deauthorizeMetaUser(payload.user_id, "deauthorize");
    logger.info("meta deauthorize callback handled", {
      cleared: result.cleared,
      unmatched: result.unmatched
    });
  } catch (err) {
    // Answer 200 regardless; a retry never comes, so the log is the record.
    logger.error("meta deauthorize callback failed", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return Response.json({ ok: true }, { status: 200 });
}
