import { getAuthUser, requireOwner } from "@/lib/auth";
import { setBusinessPaused } from "@/lib/db/businesses";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  paused: z.boolean()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const body = bodySchema.parse(await request.json());

    if (!user.isAdmin) {
      await requireOwner(body.businessId);
    }

    await setBusinessPaused(body.businessId, body.paused);
    return successResponse({ paused: body.paused });
  } catch (err) {
    return handleRouteError(err);
  }
}
