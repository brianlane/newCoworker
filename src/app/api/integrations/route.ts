import { getAuthUser, requireOwner } from "@/lib/auth";
import { deleteIntegration, getIntegrations, INTEGRATION_PROVIDERS } from "@/lib/db/integrations";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { z } from "zod";

const businessIdSchema = z.string().uuid();

const deleteSchema = z.object({
  businessId: z.string().uuid(),
  provider: z.enum(INTEGRATION_PROVIDERS)
});

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const url = new URL(request.url);
    const businessId = url.searchParams.get("businessId");
    const parsed = businessIdSchema.safeParse(businessId);
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }

    await requireOwner(parsed.data);
    const integrations = await getIntegrations(parsed.data);
    return successResponse(integrations);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const body = deleteSchema.parse(await request.json());

    if (!user.isAdmin) {
      await requireOwner(body.businessId);
    }

    await deleteIntegration(body.businessId, body.provider);
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
