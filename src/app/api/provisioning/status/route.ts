import { z } from "zod";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { requireOwner } from "@/lib/auth";
import { getLatestProvisioningStatus } from "@/lib/provisioning/progress";
import { getBusiness } from "@/lib/db/businesses";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  businessId: z.string().uuid()
});

/**
 * Owner-only: latest provisioning percent for progress UI (no internal messages).
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get("businessId");
    const parsed = querySchema.safeParse({ businessId });
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "Invalid or missing businessId");
    }

    await requireOwner(parsed.data.businessId);

    const [latest, business] = await Promise.all([
      getLatestProvisioningStatus(parsed.data.businessId),
      getBusiness(parsed.data.businessId)
    ]);

    const percent = latest?.percent ?? 0;
    const updatedAt = latest?.updatedAt ?? null;
    const infraOnline = business?.status === "online";
    const complete = infraOnline && percent >= 100;

    return successResponse({
      percent,
      updatedAt,
      complete
    });
  } catch (e) {
    return handleRouteError(e);
  }
}
