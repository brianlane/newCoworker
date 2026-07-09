import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateEnterpriseModels } from "@/lib/db/businesses";
import { enterpriseModelsSchema } from "@/lib/plans/enterprise-models";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  /** `null` clears overrides (use platform default models/voice). */
  enterpriseModels: enterpriseModelsSchema.nullable()
});

/**
 * Admin-only per-tenant model/voice overrides (mirrors
 * /api/admin/enterprise-limits). Values apply at the NEXT deploy/redeploy of
 * the tenant box — the orchestrator reads businesses.enterprise_models into
 * deploy env; nothing is live-applied here.
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = bodySchema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");
    if (business.tier !== "enterprise") {
      return errorResponse(
        "VALIDATION_ERROR",
        "Designated models apply only to enterprise tier businesses"
      );
    }

    const normalized =
      body.enterpriseModels && Object.keys(body.enterpriseModels).length > 0
        ? body.enterpriseModels
        : null;
    await updateEnterpriseModels(body.businessId, normalized);

    return successResponse({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
