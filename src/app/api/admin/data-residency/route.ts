import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateDataResidencyMode } from "@/lib/db/businesses";
import {
  DATA_RESIDENCY_MODES,
  ResidencyValidationError
} from "@/lib/residency/tier-gate";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  mode: z.enum(DATA_RESIDENCY_MODES)
});

/**
 * Admin-only flip of a tenant's data-residency rollout mode
 * (supabase → dual → vps and back). The enterprise tier gate is enforced
 * inside updateDataResidencyMode, so this route stays a thin shell —
 * the same gate protects any future caller.
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = bodySchema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    await updateDataResidencyMode(body.businessId, body.mode);

    return successResponse({ businessId: body.businessId, mode: body.mode });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    if (err instanceof ResidencyValidationError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    return handleRouteError(err);
  }
}
