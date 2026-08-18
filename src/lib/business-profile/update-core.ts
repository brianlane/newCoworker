/**
 * Shared core for the `update_business_profile` coworker tool: business
 * hours and timezone, the safest-tier profile facts owners actually ask
 * their coworker to change ("hours are 11am-6pm Toronto time").
 *
 * Byte-for-byte the Settings routes' semantics, because this core and those
 * routes must stay interchangeable:
 *  - hours merge OVER the stored value per day (omitted day = unchanged,
 *    explicit null = closed), /api/account/business-profile.
 *  - timezone is validated the way its consumer formats with it (Intl),
 *    /api/account/timezone.
 *  - after the committed column writes: refresh the canonical
 *    business_configs.profile_md block, then fire-and-forget the vault sync
 *    so the live agents pick the change up without a redeploy.
 *
 * Deliberately NOT here: phone numbers (owner or business). A wrong digit
 * cuts off owner alerts or breaks deliverability, so phone changes stay in
 * Settings behind their own guards; the MCP tool description carries the
 * same hard negative.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  isValidIanaTimezone,
  updateBusinessProfileFields,
  updateBusinessTimezone
} from "@/lib/db/businesses";
import {
  BUSINESS_HOURS_DAYS,
  isValidHoursTime,
  parseBusinessHours,
  type BusinessDayHours,
  type BusinessHours,
  type BusinessHoursDay
} from "@/lib/business-profile/profile";
import { refreshBusinessProfileMdAndLog } from "@/lib/business-profile/refresh";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BusinessProfileToolPatch = {
  /** Per-day windows to merge over the stored schedule. `null` = closed. */
  hours?: Partial<Record<BusinessHoursDay, { open: string; close: string } | null>>;
  /** IANA timezone name, e.g. "America/Toronto". */
  timezone?: string;
};

export type BusinessProfileUpdateResult =
  | { ok: true; business_hours: BusinessHours | null; timezone: string | null }
  | { ok: false; message: string };

export type BusinessProfileUpdateDeps = {
  client?: SupabaseClient;
  refreshProfileMd?: typeof refreshBusinessProfileMdAndLog;
  syncVault?: typeof syncVaultToVpsAndLog;
};

/**
 * Validate and apply an hours/timezone patch. Expected failures come back
 * as `{ ok: false }` with an owner-readable message (the MCP layer throws
 * them as tool errors); unexpected DB failures throw.
 */
export async function applyBusinessProfileUpdate(
  businessId: string,
  patch: BusinessProfileToolPatch,
  deps: BusinessProfileUpdateDeps = {}
): Promise<BusinessProfileUpdateResult> {
  const refreshProfileMd = deps.refreshProfileMd ?? refreshBusinessProfileMdAndLog;
  const syncVault = deps.syncVault ?? syncVaultToVpsAndLog;

  if (patch.hours === undefined && patch.timezone === undefined) {
    return { ok: false, message: "Nothing to update: pass hours and/or timezone." };
  }

  if (patch.hours !== undefined) {
    for (const day of BUSINESS_HOURS_DAYS) {
      const entry = patch.hours[day];
      if (!entry) continue;
      if (!isValidHoursTime(entry.open) || !isValidHoursTime(entry.close)) {
        return {
          ok: false,
          message: `Times must be 24h HH:MM (e.g. 09:00). The ${day} entry has "${entry.open}-${entry.close}".`
        };
      }
    }
  }

  if (patch.timezone !== undefined && !isValidIanaTimezone(patch.timezone)) {
    return {
      ok: false,
      message: `Unknown timezone "${patch.timezone}". Use an IANA name like America/Phoenix.`
    };
  }

  const db = deps.client ?? (await createSupabaseServiceClient());
  const { data: biz, error } = await db
    .from("businesses")
    .select("id, business_hours, timezone")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`applyBusinessProfileUpdate: ${error.message}`);
  if (!biz) return { ok: false, message: "Business not found." };

  const stored = parseBusinessHours(
    (biz as { business_hours?: unknown }).business_hours ?? null
  );

  // Merge submitted days OVER the stored value. A patch carrying only some
  // weekdays must not silently drop the previously saved schedule for the
  // others, omitting a day means "unchanged", an explicit null "closed".
  let mergedHours: BusinessHours | undefined;
  if (patch.hours !== undefined) {
    mergedHours = stored ?? {};
    for (const day of BUSINESS_HOURS_DAYS) {
      const entry = patch.hours[day];
      if (entry !== undefined) mergedHours[day] = entry as BusinessDayHours;
    }
  }

  await updateBusinessProfileFields(
    businessId,
    mergedHours !== undefined
      ? { business_hours: mergedHours as Record<string, unknown> }
      : {},
    db
  );
  if (patch.timezone !== undefined) {
    await updateBusinessTimezone(businessId, patch.timezone, db);
  }

  // Best-effort after the committed column writes: a refresh failure logs
  // and returns null instead of failing the save; the vault push must not
  // block the reply (Supabase is the source of truth).
  await refreshProfileMd(businessId, db);
  void syncVault(businessId);

  return {
    ok: true,
    business_hours: mergedHours ?? stored,
    timezone:
      patch.timezone ?? ((biz as { timezone?: string | null }).timezone || null)
  };
}
