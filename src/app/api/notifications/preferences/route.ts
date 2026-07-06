import { getAuthUser, requireOwner } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import {
  defaultNotificationPreferencesRow,
  getNotificationPreferences,
  getOrCreateNotificationPreferences,
  updateNotificationPreferences
} from "@/lib/db/notification-preferences";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { z } from "zod";

const patchSchema = z.object({
  businessId: z.string().uuid(),
  sms_urgent: z.boolean().optional(),
  email_digest: z.boolean().optional(),
  email_digest_weekly: z.boolean().optional(),
  email_urgent: z.boolean().optional(),
  dashboard_alerts: z.boolean().optional(),
  sms_warm_transfer: z.boolean().optional(),
  phone_number: z.string().max(40).nullable().optional(),
  alert_email: z.union([z.string().email(), z.literal(""), z.null()]).optional(),
  digest_email_daily: z.union([z.string().email(), z.literal(""), z.null()]).optional(),
  digest_email_weekly: z.union([z.string().email(), z.literal(""), z.null()]).optional(),
  /**
   * Set to "now" to record an "unsubscribe from all" click; null to clear
   * the audit timestamp. Re-enabling any boolean toggle also clears it
   * automatically (see `updateNotificationPreferences`).
   */
  unsubscribed_at: z.union([z.literal("now"), z.literal("clear"), z.null()]).optional()
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

    // requireOwner passes admins through, so during view-as this GET reaches
    // the tenant's data. Keep impersonation read-only: never let the
    // create-if-missing path insert a row on behalf of the tenant — serve
    // the same in-memory defaults the page renders instead.
    const prefs = (await isViewAsActive(user))
      ? ((await getNotificationPreferences(parsed.data)) ??
        defaultNotificationPreferencesRow(parsed.data))
      : await getOrCreateNotificationPreferences(parsed.data);
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

    // requireOwner passes admins through, so without this guard an admin in
    // view-as could hit Save and mutate the impersonated tenant's real prefs.
    if (await isViewAsActive(user)) {
      return errorResponse(
        "FORBIDDEN",
        "View-as is read-only; exit view-as to make changes",
        403
      );
    }

    const body = patchSchema.parse(await request.json());
    await requireOwner(body.businessId);

    const {
      businessId,
      alert_email,
      digest_email_daily,
      digest_email_weekly,
      phone_number,
      unsubscribed_at,
      ...rest
    } = body;
    const resolvedUnsubAt =
      unsubscribed_at === "now"
        ? new Date().toISOString()
        : unsubscribed_at === "clear" || unsubscribed_at === null
          ? null
          : undefined;
    const patch = {
      ...rest,
      ...(phone_number !== undefined
        ? { phone_number: phone_number?.trim() ? phone_number.trim() : null }
        : {}),
      ...(alert_email !== undefined
        ? { alert_email: alert_email?.trim() ? alert_email.trim() : null }
        : {}),
      ...(digest_email_daily !== undefined
        ? { digest_email_daily: digest_email_daily?.trim() ? digest_email_daily.trim() : null }
        : {}),
      ...(digest_email_weekly !== undefined
        ? { digest_email_weekly: digest_email_weekly?.trim() ? digest_email_weekly.trim() : null }
        : {}),
      ...(resolvedUnsubAt !== undefined ? { unsubscribed_at: resolvedUnsubAt } : {})
    };
    const prefs = await updateNotificationPreferences(businessId, patch);
    return successResponse(prefs);
  } catch (err) {
    return handleRouteError(err);
  }
}
