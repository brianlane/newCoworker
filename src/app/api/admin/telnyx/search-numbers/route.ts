import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { TelnyxNumbersClient } from "@/lib/telnyx/numbers";

const schema = z.object({
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
  limit: z.number().int().min(1).max(25).optional()
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = schema.parse(await request.json());
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return errorResponse("VALIDATION_ERROR", "TELNYX_API_KEY not configured");
    }
    const client = new TelnyxNumbersClient({ apiKey });
    const numbers = await client.searchAvailable({
      countryCode: body.countryCode,
      areaCode: body.areaCode,
      locality: body.locality,
      administrativeArea: body.administrativeArea,
      limit: body.limit ?? 10
    });
    return successResponse({ numbers });
  } catch (err) {
    return handleRouteError(err);
  }
}
