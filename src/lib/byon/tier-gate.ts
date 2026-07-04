/**
 * BYON (bring-your-own-number) is a Standard-tier perk.
 *
 * Starter tenants keep the platform-assigned number; porting in an existing
 * business number is part of the Standard/Enterprise feature gap (see the
 * fleet-economics tier relaunch plan, Phase C). The gate lives server-side so
 * every BYON API route enforces it regardless of what the UI shows.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { ByonValidationError } from "@/lib/byon/port-requests";

export const BYON_UPGRADE_MESSAGE =
  "Bring-your-own-number porting is a Standard plan perk. Upgrade to move your existing business number to your coworker.";

export function byonAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}

/**
 * Throws {@link ByonValidationError} (surfaced to the owner as a 400 with an
 * upgrade prompt) when the business is not on a BYON-eligible tier.
 */
export async function assertByonAllowedForBusiness(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`assertByonAllowedForBusiness: ${error.message}`);
  if (!byonAllowedForTier((data as { tier?: string } | null)?.tier)) {
    throw new ByonValidationError(BYON_UPGRADE_MESSAGE);
  }
}
