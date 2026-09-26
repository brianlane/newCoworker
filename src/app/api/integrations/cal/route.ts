/**
 * Dashboard Cal.com connection.
 *   GET    ?businessId=  public row (no tokens)
 *   DELETE { businessId }  soft-disable
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { deactivateCalConnection, getPublicCalConnection } from "@/lib/db/cal-connections";

const businessIdSchema = z.string().uuid();

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const businessId = businessIdSchema.parse(new URL(request.url).searchParams.get("businessId"));
    await requireBusinessRole(businessId, "manage_settings");
    const connection = await getPublicCalConnection(businessId);
    return successResponse({ connection });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = z.object({ businessId: businessIdSchema }).parse(await request.json());
    await requireBusinessRole(body.businessId, "manage_settings");
    await deactivateCalConnection(body.businessId);
    return successResponse({ disconnected: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
