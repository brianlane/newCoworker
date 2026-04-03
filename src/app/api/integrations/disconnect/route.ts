import { requireOwner, getAuthUser } from "@/lib/auth";
import { deleteIntegration } from "@/lib/db/integrations";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  provider: z.string().min(1)
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

    await deleteIntegration(body.businessId, body.provider);
    return successResponse({ disconnected: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
