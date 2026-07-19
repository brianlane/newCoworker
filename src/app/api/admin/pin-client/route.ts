import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusiness, setBusinessAdminPinned } from "@/lib/db/businesses";

/**
 * Admin-only: pin/unpin a business on the /admin/clients table. Pinned rows
 * always render at the top of the list (surviving column sorts); any number
 * of businesses can be pinned. Admin-facing only — owner dashboards are
 * untouched.
 */
const schema = z.object({
  businessId: z.string().uuid(),
  pinned: z.boolean()
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = schema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    await setBusinessAdminPinned(body.businessId, body.pinned);
    return successResponse({ businessId: body.businessId, pinned: body.pinned });
  } catch (err) {
    return handleRouteError(err);
  }
}
