import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateBusinessVpsProvider } from "@/lib/db/businesses";
import {
  VPS_PROVIDERS,
  VPS_REGIONS,
  VpsProviderValidationError,
  resolveVpsProvider
} from "@/lib/vps/provider";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  provider: z.enum(VPS_PROVIDERS),
  region: z.enum(VPS_REGIONS)
});

/**
 * Admin-only provider/region pin (enterprise-gated server-side inside
 * updateBusinessVpsProvider, same pattern as data-residency). The pin
 * drives WHICH provisioner the orchestrator uses on the NEXT provision —
 * it never moves a live box, so switching provider is refused while a box
 * exists (region-only changes on the same provider stay allowed, e.g.
 * relabeling ahead of a residency migration).
 *
 * BYOS pinning normally happens through the enrollment flow
 * (/api/admin/byos/enroll); this route is the lever for 'ovh' (Canada)
 * and for reverting an unprovisioned tenant to 'hostinger'.
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = bodySchema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    const currentProvider = resolveVpsProvider(business.vps_provider);
    if (business.hostinger_vps_id && body.provider !== currentProvider) {
      return errorResponse(
        "CONFLICT",
        `Business already has a provisioned box (${business.hostinger_vps_id}) on ` +
          `'${currentProvider}' — the provider pin only affects the NEXT provision. ` +
          "Tear down / wipe the existing box first."
      );
    }

    await updateBusinessVpsProvider(body.businessId, body.provider, body.region);
    return successResponse({
      businessId: body.businessId,
      provider: body.provider,
      region: body.region
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    if (err instanceof VpsProviderValidationError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    return handleRouteError(err);
  }
}
