/**
 * Agents — artifact PowerPoint export.
 *
 *   GET /api/dashboard/agents/runs/:runId/pptx?businessId=…
 *
 * Converts a succeeded run's markdown artifact into a downloadable .pptx
 * deck (headings → slides, bullets → bullets — see
 * src/lib/pptx/from-markdown.ts). This is how "build me a presentation"
 * agents end in an actual PowerPoint file.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError } from "@/lib/api-response";
import { getAgentRun } from "@/lib/agents/db";
import { buildSlideModel, pptxFilename, renderPptxBuffer } from "@/lib/pptx/from-markdown";

export const dynamic = "force-dynamic";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

type RouteContext = { params: Promise<{ runId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { runId } = await context.params;
    if (!z.string().uuid().safeParse(runId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid run id");
    }
    const businessId = z
      .string()
      .uuid()
      .safeParse(new URL(request.url).searchParams.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireBusinessRole(businessId.data, "view_dashboard");

    const run = await getAgentRun(businessId.data, runId);
    if (!run) return errorResponse("NOT_FOUND", "Run not found", 404);
    if (run.status !== "succeeded" || !run.output_md) {
      return errorResponse("VALIDATION_ERROR", "This run has no output to export");
    }

    const deckTitle = run.output_filename.replace(/\.[a-z0-9]+$/i, "") || "Presentation";
    const deck = buildSlideModel(run.output_md, deckTitle);
    const bytes = await renderPptxBuffer(deck);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": PPTX_MIME,
        "Content-Disposition": `attachment; filename="${pptxFilename(deckTitle)}"`,
        "cache-control": "no-store"
      }
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
