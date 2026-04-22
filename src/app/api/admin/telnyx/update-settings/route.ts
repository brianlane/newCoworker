import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import { upsertBusinessTelnyxSettings } from "@/lib/db/telnyx-routes";
import { normalizeE164 } from "@/lib/telnyx/assign-did";

/**
 * Admin-only: tweak per-tenant Telnyx feature flags without touching the DID
 * assignment. Used by the AssignDidPanel "warm transfer" and "SMS fallback"
 * toggles. All fields are optional so the UI can send partial patches.
 */
const schema = z.object({
  businessId: z.string().uuid(),
  forwardToE164: z
    .union([z.string().min(0).max(25), z.null()])
    .optional(),
  transferEnabled: z.boolean().optional(),
  smsFallbackEnabled: z.boolean().optional()
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = schema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    let normalizedForward: string | null | undefined;
    if (body.forwardToE164 === undefined) {
      normalizedForward = undefined;
    } else if (body.forwardToE164 === null || body.forwardToE164.trim().length === 0) {
      normalizedForward = null;
    } else {
      try {
        normalizedForward = normalizeE164(body.forwardToE164);
      } catch (err) {
        return errorResponse(
          "VALIDATION_ERROR",
          err instanceof Error ? err.message : "Invalid forwardToE164"
        );
      }
    }

    const settings = await upsertBusinessTelnyxSettings({
      businessId: body.businessId,
      forwardToE164: normalizedForward,
      transferEnabled: body.transferEnabled,
      smsFallbackEnabled: body.smsFallbackEnabled
    });
    return successResponse({ settings });
  } catch (err) {
    return handleRouteError(err);
  }
}
