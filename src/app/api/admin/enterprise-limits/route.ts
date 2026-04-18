import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateEnterpriseLimits } from "@/lib/db/businesses";
import { enterpriseLimitsOverrideSchema } from "@/lib/plans/enterprise-limits";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  /** `null` clears overrides (use platform enterprise defaults). */
  enterpriseLimits: enterpriseLimitsOverrideSchema.nullable()
});

export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = bodySchema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");
    if (business.tier !== "enterprise") {
      return errorResponse("VALIDATION_ERROR", "Enterprise limits apply only to enterprise tier businesses");
    }

    await updateEnterpriseLimits(body.businessId, body.enterpriseLimits);

    return successResponse({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
