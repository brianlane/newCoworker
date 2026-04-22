import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import { TelnyxNumbersClient } from "@/lib/telnyx/numbers";
import {
  orderAndAssignDidForBusiness,
  OrderAndAssignError,
  normalizeE164
} from "@/lib/telnyx/assign-did";
import { readPlatformTelnyxDefaults } from "@/lib/telnyx/platform-defaults";

const schema = z.object({
  businessId: z.string().uuid(),
  countryCode: z.string().min(2).max(2).optional(),
  areaCode: z
    .string()
    .regex(/^\d{3}$/u, "areaCode must be 3 digits")
    .optional(),
  locality: z.string().min(1).max(120).optional(),
  administrativeArea: z
    .string()
    .regex(/^[A-Za-z]{2}$/u, "administrativeArea must be a 2-letter code")
    .optional(),
  /**
   * Admin picked an exact DID (e.g. clicked "Buy & assign" next to a specific
   * row in the search results). When present, we order that number instead of
   * re-searching and taking `candidates[0]`, which would have caused the admin
   * to pay for a different number than the one shown in the UI.
   */
  specificNumber: z.string().min(4).max(25).optional()
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = schema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) return errorResponse("VALIDATION_ERROR", "TELNYX_API_KEY not configured");

    let normalizedSpecific: string | undefined;
    if (body.specificNumber && body.specificNumber.trim().length > 0) {
      try {
        normalizedSpecific = normalizeE164(body.specificNumber);
      } catch (err) {
        return errorResponse(
          "VALIDATION_ERROR",
          err instanceof Error ? err.message : "Invalid specificNumber"
        );
      }
    }

    const telnyxNumbers = new TelnyxNumbersClient({ apiKey });
    const result = await orderAndAssignDidForBusiness(
      {
        businessId: body.businessId,
        platformDefaults: readPlatformTelnyxDefaults(),
        specificNumber: normalizedSpecific,
        search: {
          countryCode: body.countryCode,
          areaCode: body.areaCode,
          locality: body.locality,
          administrativeArea: body.administrativeArea
        }
      },
      { telnyxNumbers }
    );
    return successResponse(result);
  } catch (err) {
    if (err instanceof OrderAndAssignError) {
      return errorResponse("CONFLICT", err.message);
    }
    return handleRouteError(err);
  }
}
