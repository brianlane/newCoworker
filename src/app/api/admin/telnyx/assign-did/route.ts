import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import { TelnyxNumbersClient } from "@/lib/telnyx/numbers";
import { assignExistingDidToBusiness, normalizeE164 } from "@/lib/telnyx/assign-did";
import { readPlatformTelnyxDefaults } from "@/lib/telnyx/platform-defaults";

const schema = z.object({
  businessId: z.string().uuid(),
  toE164: z.string().min(8).max(20),
  associateWithPlatform: z.boolean().optional()
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = schema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    const toE164 = normalizeE164(body.toE164);
    const associate = body.associateWithPlatform ?? true;

    const apiKey = process.env.TELNYX_API_KEY;
    if (associate && !apiKey) {
      return errorResponse("VALIDATION_ERROR", "TELNYX_API_KEY not configured");
    }

    const telnyxNumbers = associate ? new TelnyxNumbersClient({ apiKey: apiKey ?? "" }) : undefined;
    const result = await assignExistingDidToBusiness(
      {
        businessId: body.businessId,
        toE164,
        associateWithPlatform: associate,
        platformDefaults: readPlatformTelnyxDefaults()
      },
      { telnyxNumbers }
    );
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
