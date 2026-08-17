/**
 * White-label branding (enterprise): read/update the active business's
 * dashboard branding.
 *
 * GET  ?businessId=            → stored branding (or null)
 * POST { businessId, branding } → set; `branding: null` clears to platform
 *      default. Writes are manage_settings (owner or manager; platform
 *      admin passes) + enterprise-tier gated server-side. Both verbs take an
 *      explicit businessId, so an admin in view-as reads and writes the
 *      tenant they are viewing.
 */
import { z } from "zod";
import { requireBusinessRole } from "@/lib/auth";
import { brandingSchema, parseBranding } from "@/lib/plans/branding";
import { getBusiness, updateBusinessBranding } from "@/lib/db/businesses";
import { teamAccessAllowedForTier } from "@/lib/team/tier-gate";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const businessId = z.string().uuid().parse(url.searchParams.get("businessId") ?? "");
    await requireBusinessRole(businessId, "manage_settings");
    const business = await getBusiness(businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");
    return successResponse({
      branding: parseBranding((business as { branding?: unknown }).branding)
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid query");
    }
    return handleRouteError(err);
  }
}

const bodySchema = z.object({
  businessId: z.string().uuid(),
  branding: brandingSchema.nullable()
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    await requireBusinessRole(body.businessId, "manage_settings");

    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");
    // Same tier predicate the team gate uses (enterprise-only). Clearing
    // back to platform branding is allowed on any tier so a downgraded
    // tenant can always shed stale branding.
    if (body.branding !== null && !teamAccessAllowedForTier(business.tier)) {
      return errorResponse(
        "FORBIDDEN",
        "White-label branding is an Enterprise plan feature",
        403
      );
    }

    const normalized =
      body.branding && Object.keys(body.branding).length > 0 ? body.branding : null;
    await updateBusinessBranding(body.businessId, normalized);
    return successResponse({ ok: true, branding: normalized });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
