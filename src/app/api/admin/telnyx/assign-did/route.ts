import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import { TelnyxNumbersClient } from "@/lib/telnyx/numbers";
import { assignExistingDidToBusiness, normalizeE164 } from "@/lib/telnyx/assign-did";
import {
  assertPlatformTelnyxDefaults,
  MissingTelnyxDefaultsError,
  readPlatformTelnyxDefaults
} from "@/lib/telnyx/platform-defaults";

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

    // Same loud-on-missing rule as order-did, but only when we're
    // actually going to PATCH the number on Telnyx. associate=false is
    // a manual reroute scenario (admin already wired the DID by hand
    // and just wants the DB rows updated) — gating that on
    // TELNYX_CONNECTION_ID would block legitimate manual recoveries.
    const platformDefaults = readPlatformTelnyxDefaults();
    if (associate) {
      try {
        assertPlatformTelnyxDefaults(platformDefaults);
      } catch (err) {
        if (err instanceof MissingTelnyxDefaultsError) {
          return errorResponse("VALIDATION_ERROR", err.message);
        }
        throw err;
      }
    }

    const telnyxNumbers = associate ? new TelnyxNumbersClient({ apiKey: apiKey ?? "" }) : undefined;
    const result = await assignExistingDidToBusiness(
      {
        businessId: body.businessId,
        toE164,
        associateWithPlatform: associate,
        platformDefaults
      },
      { telnyxNumbers }
    );
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
