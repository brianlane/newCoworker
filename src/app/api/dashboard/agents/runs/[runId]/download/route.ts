/**
 * Agents — artifact download.
 *
 *   GET /api/dashboard/agents/runs/:runId/download?businessId=…
 *
 * Streams the run's produced artifact as a file attachment (markdown, or
 * the same text format as the input for same_as_input agents).
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError } from "@/lib/api-response";
import { getAgentRun } from "@/lib/agents/db";

export const dynamic = "force-dynamic";

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
      return errorResponse("VALIDATION_ERROR", "This run has no output to download");
    }

    const filename = run.output_filename || "output.md";
    // ASCII fallback for the quoted filename; RFC 5987 encoding carries the
    // real name for non-ASCII originals.
    const asciiName = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
    return new Response(run.output_md, {
      status: 200,
      headers: {
        "content-type": `${run.output_mime_type || "text/markdown"}; charset=utf-8`,
        "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "cache-control": "no-store"
      }
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
