import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateBusinessHipaaMode } from "@/lib/db/businesses";
import { HipaaValidationError } from "@/lib/hipaa/tier-gate";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  enabled: z.boolean()
});

/**
 * Admin-only flip of a tenant into or out of the HIPAA lane. The enterprise
 * tier gate is enforced inside updateBusinessHipaaMode, so this route stays a
 * thin shell and the same gate protects any future caller. Same shape as
 * /api/admin/data-residency.
 *
 * Placement is deliberately NOT checked here: a tenant is legitimately
 * flipped on before its box is moved off the default fleet. The refusal lands
 * at provision time instead (src/lib/hipaa/placement.ts), which is the moment
 * PHI would actually reach non-covered infrastructure.
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = bodySchema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    await updateBusinessHipaaMode(body.businessId, body.enabled);

    return successResponse({ businessId: body.businessId, hipaaMode: body.enabled });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    if (err instanceof HipaaValidationError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    return handleRouteError(err);
  }
}
