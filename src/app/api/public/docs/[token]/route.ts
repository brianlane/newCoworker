/**
 * Public tokenized document download: GET /api/public/docs/:token
 *
 * The token is the whole capability (256-bit random, stored only as
 * sha256). The resolver fails closed on every non-servable state — unknown
 * token, revoked, link expired, document expired/deleted/not-ready — so a
 * link minted while a document was fresh stops working the moment the
 * document itself expires. Responses for every failure are an identical
 * plain 404 (no reason leaks to strangers probing tokens).
 */

import { resolveDocumentShareByToken } from "@/lib/documents/share";
import { touchDocumentShareAccess } from "@/lib/documents/db";
import { BUSINESS_DOCS_BUCKET } from "@/lib/documents/core";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
}

type RouteContext = { params: Promise<{ token: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { token } = await context.params;
  if (!token || token.length > 200) return notFound();

  let resolved;
  try {
    resolved = await resolveDocumentShareByToken(token);
  } catch (err) {
    logger.warn("public/docs: share resolve failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return notFound();
  }
  if (!resolved.ok) return notFound();

  const db = await createSupabaseServiceClient();
  const { data, error } = await db.storage
    .from(BUSINESS_DOCS_BUCKET)
    .download(resolved.document.storage_path);
  if (error || !data) {
    logger.warn("public/docs: storage download failed", {
      documentId: resolved.document.id,
      error: error?.message ?? "no data"
    });
    return notFound();
  }

  // Access telemetry is best-effort — never block or fail the download.
  touchDocumentShareAccess(resolved.share.id, resolved.share.access_count).catch(() => {});

  const filename = resolved.document.storage_path.split("/").pop() ?? "document";
  return new Response(data, {
    status: 200,
    headers: {
      "content-type": resolved.document.mime_type,
      "content-disposition": `inline; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "cache-control": "private, no-store"
    }
  });
}
