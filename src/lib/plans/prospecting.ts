/**
 * Prospecting (outbound Places discovery + cold email) is a Standard-tier perk.
 *
 * Places Enterprise queries, Resend volume, and AI pitch polish make this a
 * cost leak on Starter. The gate lives server-side (same pattern as
 * src/lib/plans/sms-tools.ts) so settings writes, manual Send, and the
 * outreach sweep all refuse Starter regardless of what the UI shows. A
 * downgrade leaves stored settings alone but stops discovery and sends until
 * the tenant upgrades again. Turning the feature OFF always works.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { QUERIES_PER_RUN } from "@/lib/outreach/discover";

export const PROSPECTING_UPGRADE_MESSAGE =
  "Prospecting is a Standard plan perk. Upgrade to have your coworker find local businesses and email them for you.";

export function prospectingAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}

/**
 * Paid Places queries a tenant's daily discovery pass may buy. Discovery
 * bills at the Text Search Enterprise tier, so this number is the platform's
 * per-tenant Places cost lever: Standard gets the base budget, Enterprise
 * double it. With every tier bounded, the fleet-wide worst case stays a
 * small known number instead of an open-ended one.
 */
export function placesQueriesPerDayForTier(tier: string | null | undefined): number {
  return tier === "enterprise" ? QUERIES_PER_RUN * 2 : QUERIES_PER_RUN;
}

/**
 * Resolve whether the business's tier allows Prospecting. Throws on lookup
 * failure (routes surface it via handleRouteError as a 500; the sweep treats
 * it as a per-business failure and continues).
 */
export async function prospectingAllowedForBusiness(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`prospectingAllowedForBusiness: ${error.message}`);
  return prospectingAllowedForTier((data as { tier?: string } | null)?.tier);
}
