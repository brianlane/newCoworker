/**
 * AI-assist authoring: POST a plain-English description, get back a VALIDATED
 * AiFlow definition candidate the builder can load into the form.
 *
 * Owner-only. The full pipeline (Gemini call, metering, validation,
 * self-repair, salvage) lives in the shared compile service
 * (src/lib/ai-flows/compile-service.ts) — also used by the dashboard-chat
 * `create_aiflow` tool. The route returns the structured definition; it does
 * NOT persist anything (the owner reviews/edits, then saves via POST
 * /api/aiflows).
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { compileAiFlowFromDescription } from "@/lib/ai-flows/compile-service";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  description: z.string().min(1).max(4000)
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_aiflows");

    const result = await compileAiFlowFromDescription({
      businessId: body.businessId,
      description: body.description
    });
    if (!result.ok) {
      if (result.error === "not_configured") {
        return errorResponse("INTERNAL_SERVER_ERROR", result.message);
      }
      return errorResponse("VALIDATION_ERROR", result.message);
    }
    return successResponse(
      result.warnings.length > 0
        ? { definition: result.definition, warnings: result.warnings }
        : { definition: result.definition }
    );
  } catch (err) {
    return handleRouteError(err);
  }
}
