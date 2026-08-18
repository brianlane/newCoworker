/**
 * POST /api/webhooks/meta/data-deletion — Meta's Data Deletion Request
 * callback.
 *
 * Meta calls this when a person removes New Coworker AND asks us to delete
 * what Facebook gave us about them. Register the URL in the App Dashboard
 * under Facebook Login → Settings → "Data Deletion Request URL".
 *
 * Meta's contract, which is stricter than the deauthorize one: respond with
 * JSON carrying a status `url` and an alphanumeric `confirmation_code`, and
 * that URL must show the person a human-readable account of what happened.
 * Meta's docs are explicit that failing to comply can get the callback
 * removed or the app disabled, so this answers 200 with a well-formed body on
 * every path, including a rejected signature.
 *
 * Authentication is the `signed_request` HMAC and nothing else. Under
 * /api/webhooks/ so the CSRF gate in src/proxy.ts exempts it.
 */
import { verifyMetaSignedRequest, readSignedRequestField } from "@/lib/meta/signed-request";
import { deauthorizeMetaUser } from "@/lib/meta/deauthorize";
import {
  generateConfirmationCode,
  insertMetaDeletionRequest,
  type MetaDeletionRequestStatus
} from "@/lib/meta/deletion-requests";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where the person reads what happened. Must be absolute and HTTPS. */
function statusUrl(request: Request, code: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
  return `${base}/privacy/data-deletion/status?code=${encodeURIComponent(code)}`;
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text().catch(() => "");
  const signedRequest = readSignedRequestField(rawBody, request.headers.get("content-type"));
  const payload = verifyMetaSignedRequest(signedRequest);
  const code = generateConfirmationCode();

  if (!payload) {
    // Nothing is deleted on an unverified request, but Meta still needs the
    // documented shape back. The status page will report the refusal, which
    // is the honest thing to show: a real person following this link needs
    // to know their request did not reach us.
    logger.warn("meta data deletion callback rejected", {
      hasField: Boolean(signedRequest)
    });
    return Response.json(
      { url: statusUrl(request, code), confirmation_code: code },
      { status: 200 }
    );
  }

  let status: MetaDeletionRequestStatus = "completed";
  let cleared = 0;
  let detail: string | null = null;
  try {
    const result = await deauthorizeMetaUser(payload.user_id, "data_deletion");
    cleared = result.cleared;
    // "We hold nothing for you" is a real, complete answer, not a failure:
    // the person may have removed the app before we recorded their id, or
    // never finished connecting. The status page says so in plain words.
    status = result.unmatched || result.cleared === 0 ? "no_data" : "completed";
  } catch (err) {
    status = "failed";
    detail = err instanceof Error ? err.message : String(err);
    logger.error("meta data deletion callback failed", { error: detail });
  }

  try {
    await insertMetaDeletionRequest({
      confirmationCode: code,
      metaUserId: payload.user_id,
      connectionsCleared: cleared,
      status,
      detail
    });
  } catch (err) {
    // The deletion itself already happened. Losing the ledger row means the
    // status page cannot find the code, so log loudly rather than silently.
    logger.error("meta data deletion ledger write failed", {
      confirmationCode: code,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  return Response.json(
    { url: statusUrl(request, code), confirmation_code: code },
    { status: 200 }
  );
}
