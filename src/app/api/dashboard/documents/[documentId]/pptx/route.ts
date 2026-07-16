/**
 * Documents — PowerPoint export.
 *
 *   GET /api/dashboard/documents/:documentId/pptx?businessId=…
 *
 * Converts the document's agent-facing markdown (`content_md` — the same
 * text the coworker answers from) into a downloadable .pptx deck. Headings
 * become slides, bullets become bullets; see src/lib/pptx/from-markdown.ts
 * for the model and its caps.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusinessDocument } from "@/lib/documents/db";
import { buildSlideModel, pptxFilename, renderPptxBuffer } from "@/lib/pptx/from-markdown";

export const dynamic = "force-dynamic";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

type RouteContext = { params: Promise<{ documentId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { documentId } = await context.params;
    if (!z.string().uuid().safeParse(documentId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid document id");
    }
    const businessId = z
      .string()
      .uuid()
      .safeParse(new URL(request.url).searchParams.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireBusinessRole(businessId.data, "view_dashboard");

    const document = await getBusinessDocument(businessId.data, documentId);
    if (!document) return errorResponse("NOT_FOUND", "Document not found", 404);
    if (document.status !== "ready" || !document.content_md.trim()) {
      return errorResponse("VALIDATION_ERROR", "That document has no content to export yet");
    }

    const deck = buildSlideModel(document.content_md, document.title);
    const bytes = await renderPptxBuffer(deck);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": PPTX_MIME,
        "Content-Disposition": `attachment; filename="${pptxFilename(document.title)}"`,
        "cache-control": "no-store"
      }
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
