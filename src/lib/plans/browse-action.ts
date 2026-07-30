/**
 * AiFlow `browse_action` steps are a Standard-tier perk.
 *
 * They need the render sidecar (already omitted on Starter hardware). The
 * gate also refuses save/API so Starter authors get an upgrade message
 * instead of a silent runtime failure.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  BROWSE_ACTION_UPGRADE_MESSAGE,
  browseActionAllowedForTier
} from "../../../supabase/functions/_shared/browse_action_tier";

export { BROWSE_ACTION_UPGRADE_MESSAGE, browseActionAllowedForTier };

export async function browseActionAllowedForBusiness(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`browseActionAllowedForBusiness: ${error.message}`);
  return browseActionAllowedForTier((data as { tier?: string } | null)?.tier);
}
