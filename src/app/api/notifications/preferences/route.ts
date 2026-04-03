import { getAuthUser, requireOwner } from "@/lib/auth";
import {
  getOrCreateNotificationPreferences,
  updateNotificationPreferences
} from "@/lib/db/notification-preferences";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { z } from "zod";

const patchSchema = z.object({
  businessId: z.string().uuid(),
  sms_urgent: z.boolean().optional(),
  email_digest: z.boolean().optional(),
  email_urgent: z.boolean().optional(),
  dashboard_alerts: z.boolean().optional(),
  phone_number: z.string().max(40).nullable().optional(),
  alert_email: z.union([z.string().email(), z.literal(""), z.null()]).optional()
});

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const url = new URL(request.url);
    const businessId = url.searchParams.get("businessId");
    const parsed = z.string().uuid().safeParse(businessId);
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }

    await requireOwner(parsed.data);

    const prefs = await getOrCreateNotificationPreferences(parsed.data);
    return successResponse(prefs);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const body = patchSchema.parse(await request.json());
    await requireOwner(body.businessId);

    const { businessId, alert_email, ...rest } = body;
    const patch = {
      ...rest,
      ...(alert_email !== undefined
        ? { alert_email: alert_email === "" ? null : alert_email }
        : {})
    };
    const prefs = await updateNotificationPreferences(businessId, patch);
    return successResponse(prefs);
  } catch (err) {
    return handleRouteError(err);
  }
}
