import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  getOrCreateNotificationPreferences,
  updateNotificationPreferences
} from "@/lib/db/notification-preferences";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { coerceOwnerPhoneToE164 } from "@/lib/telnyx/assign-did";
import { z } from "zod";

const patchSchema = z.object({
  businessId: z.string().uuid(),
  sms_urgent: z.boolean().optional(),
  whatsapp_urgent: z.boolean().optional(),
  whatsapp_replaces_sms: z.boolean().optional(),
  slack_urgent: z.boolean().optional(),
  telegram_urgent: z.boolean().optional(),
  teams_urgent: z.boolean().optional(),
  slack_digest: z.boolean().optional(),
  push_urgent: z.boolean().optional(),
  email_digest: z.boolean().optional(),
  email_digest_weekly: z.boolean().optional(),
  email_urgent: z.boolean().optional(),
  dashboard_alerts: z.boolean().optional(),
  sms_warm_transfer: z.boolean().optional(),
  image_limit_alerts: z.boolean().optional(),
  aiflow_failure_alerts: z.boolean().optional(),
  customer_reply_alerts: z.boolean().optional(),
  unassigned_booking_alerts: z.boolean().optional(),
  booking_alert_audience: z.enum(["owner", "employees", "both"]).optional(),
  /** Null (or an empty array) means every active member. */
  booking_alert_member_ids: z.array(z.string().uuid()).nullable().optional(),
  category_leads: z.boolean().optional(),
  category_team: z.boolean().optional(),
  category_system: z.boolean().optional(),
  digest_customer_facing_only: z.boolean().optional(),
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

    await requireBusinessRole(parsed.data, "manage_settings");

    // requireBusinessRole passes admins through, so during view-as this GET
    // reaches the tenant's data, and the create-if-missing path runs for an
    // impersonating admin exactly as it would on the owner's first visit.
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

    // Business-scoped by the explicit businessId below, so an admin in
    // view-as saves the tenant's prefs (not their own), which is the point.
    const body = patchSchema.parse(await request.json());
    await requireBusinessRole(body.businessId, "manage_settings");

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
    // Normalize the alert phone to E.164 BEFORE it persists. This field is
    // handed verbatim to Telnyx as the SMS `to`, a raw "6026951142" saved
    // here sat dormant for a month and then failed the tenant's first urgent
    // alert with Telnyx 40310 "Invalid 'to' address" (Amy, July 2026). NANP
    // coercion (bare 10-digit → +1) keeps the common US/Canada input working;
    // anything we can't safely coerce is rejected with actionable feedback
    // instead of stored as a landmine.
    let resolvedPhone: string | null | undefined;
    if (phone_number !== undefined) {
      const trimmed = phone_number?.trim() || "";
      if (!trimmed) {
        resolvedPhone = null;
      } else {
        const coerced = coerceOwnerPhoneToE164(trimmed);
        if (!coerced) {
          return errorResponse(
            "VALIDATION_ERROR",
            "Alert phone must be a valid number in international format, e.g. +1 555 123 4567 (10-digit US/Canada numbers are accepted without the +1)."
          );
        }
        resolvedPhone = coerced;
      }
    }
    const patch = {
      ...rest,
      ...(resolvedPhone !== undefined ? { phone_number: resolvedPhone } : {}),
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
