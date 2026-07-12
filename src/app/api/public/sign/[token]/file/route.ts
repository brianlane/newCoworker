/**
 * Original-file download for a signing link: GET /api/public/sign/:token/file
 *
 * Serves the stored upload (PDF etc.) behind the SAME signing token, so a
 * signer can review the original document, with identical fail-closed
 * semantics to the signing page (plain 404 on every non-servable state).
 */

import { resolveSignatureRequestByToken } from "@/lib/documents/signing";
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
    resolved = await resolveSignatureRequestByToken(token);
  } catch (err) {
    logger.warn("public/sign/file: resolve failed", {
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
    logger.warn("public/sign/file: storage download failed", {
      documentId: resolved.document.id,
      error: error?.message ?? "no data"
    });
    return notFound();
  }

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
