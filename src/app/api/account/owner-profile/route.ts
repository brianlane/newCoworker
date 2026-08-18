/**
 * Owner-facing: update the owner's display name and contact phone on the
 * active business row. The phone also appears in the rendered Business
 * profile block, so the save refreshes `profile_md` + kicks the vault sync.
 *
 * The owner's phone lives in THREE columns read by different features
 * (`businesses.phone` → profile_md/provisioning; `notification_preferences.
 * phone_number` → urgent alerts; `business_telnyx_settings.forward_to_e164`
 * → AiFlow notify_owner, warm transfer, Safe Mode). Historically they were
 * edited on three separate pages, and a partial change is exactly the
 * failure the July 2026 KYP onboarding incident documented (all three had
 * to be repaired by hand). `syncLinkedNumbers` closes that class of bug:
 * when the saved phone changes, any of the other two columns still holding
 * the OLD number moves with it in the same save.
 *
 * The phone is coerced to E.164 before persisting (previously a loose
 * character-class check let a bare local "6123 4567" save verbatim and get
 * dialed as-is), and the response carries a deliverability warning when the
 * number is outside NANP (+1), which the platform's long-code numbers
 * cannot text at all, so a silent SMS outage becomes visible at save time.
 */
import { z } from "zod";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { updateBusinessProfileFields } from "@/lib/db/businesses";
import { refreshBusinessProfileMdAndLog } from "@/lib/business-profile/refresh";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";
import { coerceOwnerPhoneToE164 } from "@/lib/phone/e164";
import { ownerPhoneDeliverabilityWarning } from "@/lib/phone/deliverability";
import { updateNotificationPreferences } from "@/lib/db/notification-preferences";
import { setForwardToE164 } from "@/lib/db/telnyx-routes";
import { logger } from "@/lib/logger";

const schema = z.object({
  ownerName: z.string().trim().max(120, "Name is too long").optional(),
  phone: z.string().trim().max(40, "Phone number is too long").optional(),
  /**
   * When the phone changes, also move the alert phone
   * (notification_preferences.phone_number) and the forwarding cell
   * (business_telnyx_settings.forward_to_e164) IF they still hold the old
   * number. Never touches a column the owner pointed somewhere else.
   */
  syncLinkedNumbers: z.boolean().optional()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");

    const body = schema.parse(await request.json());

    // Coerce BEFORE persisting: this value feeds profile_md (what the live
    // AI tells callers), the notification seed, and the forwarding default,
    // all of which hand it to Telnyx as a dial/SMS target. NANP coercion
    // (bare 10-digit → +1) keeps common input working; anything uncoercible
    // is rejected with actionable feedback instead of stored as a landmine.
    let resolvedPhone: string | null | undefined;
    if (body.phone !== undefined) {
      const trimmed = body.phone.trim();
      if (!trimmed) {
        resolvedPhone = null;
      } else {
        const coerced = coerceOwnerPhoneToE164(trimmed);
        if (!coerced) {
          return errorResponse(
            "VALIDATION_ERROR",
            "Enter a valid phone number in international format, e.g. +1 555 123 4567 (10-digit US/Canada numbers are accepted without the +1)."
          );
        }
        resolvedPhone = coerced;
      }
    }

    const db = await createSupabaseServiceClient();
    // Owner-only (`manage_billing` = owner in the role policy): this card
    // edits the OWNER's contact identity (alerts, handoff line, profile_md),
    // a manager must not be able to rewrite it.
    const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_billing");
    const { data: biz } = await db
      .from("businesses")
      .select("id, phone")
      .in("id", activeBusinessId ? [activeBusinessId] : [])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!biz) return errorResponse("NOT_FOUND", "No business found for this account");
    const businessId = (biz as { id: string }).id;
    const previousPhone = coerceOwnerPhoneToE164((biz as { phone?: string | null }).phone);

    let wroteAnything = false;
    let writeError: unknown = null;
    if (body.ownerName !== undefined) {
      const { error } = await db
        .from("businesses")
        .update({ owner_name: body.ownerName || null })
        .eq("id", businessId);
      if (error) throw new Error(`owner-profile: ${error.message}`);
      wroteAnything = true;
    }
    if (resolvedPhone !== undefined) {
      try {
        await updateBusinessProfileFields(businessId, { phone: resolvedPhone }, db);
        wroteAnything = true;
      } catch (err) {
        // Defer the failure: the owner_name write above may already have
        // landed, and the refresh below must still run so profile_md (and
        // the live agent) reflects the committed name change.
        writeError = err;
      }
    }

    // Move the linked owner-phone columns with the change. A column moves
    // when it provably TRACKED the primary (it equals the previous number,
    // compared post-coercion since the three columns historically stored
    // different formats of one number) or when it is EMPTY / legacy junk
    // that coerces to nothing (there is no deliberate value to preserve,
    // and both columns are already seeded from businesses.phone elsewhere:
    // notification-prefs on first insert, forward_to_e164 at provisioning).
    // A column pointing at a DIFFERENT real number was set on purpose and
    // is never touched. Clearing the phone never clears the linked columns:
    // blanking forward_to_e164 would silently disable Safe Mode.
    //
    // The whole block is gated on the phone actually CHANGING in this save:
    // a name-only edit or idempotent resave must not refill a forwarding
    // number the owner deliberately cleared via the forwarding-phone API
    // (that clear also auto-disabled Safe Mode; resurrecting it from an
    // unrelated profile save would be surprising).
    let syncedAlertPhone = false;
    let syncedForwardingPhone = false;
    if (
      body.syncLinkedNumbers === true &&
      writeError === null &&
      typeof resolvedPhone === "string" &&
      resolvedPhone !== previousPhone
    ) {
      const [prefsRes, telnyxRes] = await Promise.all([
        db
          .from("notification_preferences")
          .select("phone_number")
          .eq("business_id", businessId)
          .maybeSingle(),
        db
          .from("business_telnyx_settings")
          .select("forward_to_e164")
          .eq("business_id", businessId)
          .maybeSingle()
      ]);
      const alertPhone = coerceOwnerPhoneToE164(
        (prefsRes.data as { phone_number?: string | null } | null)?.phone_number
      );
      const forwardPhone = coerceOwnerPhoneToE164(
        (telnyxRes.data as { forward_to_e164?: string | null } | null)?.forward_to_e164
      );
      const shouldMove = (current: string | null): boolean =>
        current !== resolvedPhone &&
        (current === null || (previousPhone !== null && current === previousPhone));
      // Best-effort per column: a failed sync must not roll back the
      // committed primary write, but it must be visible in the response
      // (the flags stay false) and in the logs.
      if (shouldMove(alertPhone)) {
        try {
          await updateNotificationPreferences(businessId, { phone_number: resolvedPhone });
          syncedAlertPhone = true;
        } catch (err) {
          logger.warn("owner-profile: alert-phone sync failed", {
            businessId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
      if (shouldMove(forwardPhone)) {
        try {
          await setForwardToE164(businessId, resolvedPhone);
          syncedForwardingPhone = true;
        } catch (err) {
          logger.warn("owner-profile: forwarding-phone sync failed", {
            businessId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    if (wroteAnything) {
      // Both facts appear in the rendered profile block the agent is
      // grounded on, re-render and push so the coworker stops using the
      // old primary-contact name/number immediately. Best-effort: never
      // fails the committed writes (and never masks writeError below).
      await refreshBusinessProfileMdAndLog(businessId, db);
      void syncVaultToVpsAndLog(businessId);
    }
    if (writeError) throw writeError;

    // Deliverability: a non-NANP number saves fine and then every SMS to it
    // fails with 40309 (our long codes cannot originate international SMS,
    // see src/lib/phone/deliverability.ts). Surface that at save time
    // instead of letting alerts go silently dark.
    const warning =
      typeof resolvedPhone === "string" ? ownerPhoneDeliverabilityWarning(resolvedPhone) : null;

    return successResponse({
      ok: true,
      phone: resolvedPhone === undefined ? undefined : resolvedPhone,
      syncedAlertPhone,
      syncedForwardingPhone,
      warning
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
