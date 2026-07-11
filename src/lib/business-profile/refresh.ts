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
import { parseBusinessHours, renderBusinessProfileMd } from "@/lib/business-profile/profile";

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
  const md = renderBusinessProfileMd({
    name: business.name,
    ownerName: business.owner_name ?? null,
    businessType: business.business_type ?? null,
    phone: business.phone ?? null,
    address: business.address ?? null,
    timezone: business.timezone ?? null,
    hours: parseBusinessHours(business.business_hours ?? null)
  });
  await patchBusinessConfig(businessId, { profile_md: md }, db);
  return md;
}
