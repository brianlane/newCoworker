/**
 * Re-derive `business_configs.profile_md` from the current businesses row.
 *
 * Called after any write that changes a profile-visible fact (the Business
 * profile save, business rename, timezone change) so the canonical rendered
 * block every prompt composer reads never goes stale. Callers follow up with
 * `syncVaultToVpsAndLog` (fire-and-forget) to push the refreshed vault to
 * the live box.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusiness } from "@/lib/db/businesses";
import { patchBusinessConfig } from "@/lib/db/configs";
import { listBusinessServices } from "@/lib/services/db";
import { parseBusinessHours, renderBusinessProfileMd } from "@/lib/business-profile/profile";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export async function refreshBusinessProfileMd(
  businessId: string,
  client?: SupabaseClient
): Promise<string> {
  const db = client ?? (await createSupabaseServiceClient());
  const business = await getBusiness(businessId, db);
  if (!business) {
    throw new Error(`refreshBusinessProfileMd: business ${businessId} not found`);
  }
  // Services must never break a profile refresh: a table/read failure just
  // renders the profile without the catalog section.
  const services = await listBusinessServices(businessId, db).catch((err: unknown) => {
    logger.warn("refreshBusinessProfileMd: services list failed; rendering without services", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return [];
  });
  const md = renderBusinessProfileMd({
    name: business.name,
    ownerName: business.owner_name ?? null,
    businessType: business.business_type ?? null,
    phone: business.phone ?? null,
    address: business.address ?? null,
    timezone: business.timezone ?? null,
    hours: parseBusinessHours(business.business_hours ?? null),
    services: services
      .filter((s) => s.active)
      .map((s) => ({
        name: s.name,
        description: s.description,
        durationMinutes: s.duration_minutes,
        priceText: s.price_text
      }))
  });
  await patchBusinessConfig(businessId, { profile_md: md }, db);
  return md;
}

/**
 * Non-throwing variant for routes whose PRIMARY write (the businesses-row
 * update) has already succeeded: a refresh failure must not turn the
 * caller's successful save into an error response. Logs at warn so drift
 * (stale profile_md until the next save) is visible in monitoring. Mirrors
 * the `syncVaultToVpsAndLog` contract.
 */
export async function refreshBusinessProfileMdAndLog(
  businessId: string,
  client?: SupabaseClient
): Promise<string | null> {
  try {
    return await refreshBusinessProfileMd(businessId, client);
  } catch (err) {
    logger.warn("business profile refresh failed (profile_md may be stale)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
