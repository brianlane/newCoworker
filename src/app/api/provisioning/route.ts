import { requireAdmin } from "@/lib/auth";
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";
import { getBusiness } from "@/lib/db/businesses";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const schema = z.object({
  businessId: z.string().uuid(),
  ownerEmail: z.string().email().optional(),
  ownerPhone: z.string().optional()
});

export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = schema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    const result = await orchestrateProvisioning({
      businessId: body.businessId,
      tier: business.tier,
      ownerEmail: body.ownerEmail ?? business.owner_email,
      ownerPhone: body.ownerPhone
    });

    return successResponse(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
