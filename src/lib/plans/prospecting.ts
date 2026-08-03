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
 * Whether the plan makes the owner type a postal address into the Prospecting
 * panel before outreach can be switched on.
 *
 * Enterprise is exempt. That is a change to WHERE the footer address comes
 * from, not a claim that cold mail stopped needing one: an exempt tenant's
 * footer falls back to the address on their business profile
 * (`businesses.address`), and only prints nothing when they have no address
 * anywhere. Enterprise tenants run their own compliance footer decisions with
 * their own counsel, so the platform stops making the panel a hard gate for
 * them and keeps it a hard gate for everyone else, where the DB check
 * constraint still makes it structural.
 */
export function postalAddressRequiredForTier(tier: string | null | undefined): boolean {
  return tier !== "enterprise";
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
 * The business's tier, for the gates above. Throws on lookup failure (routes
 * surface it via handleRouteError as a 500; the sweep treats it as a
 * per-business failure and continues), because a failed read must never read
 * as "no tier" and quietly downgrade a paying tenant.
 */
export async function prospectingTierForBusiness(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`prospectingTierForBusiness: ${error.message}`);
  return (data as { tier?: string | null } | null)?.tier ?? null;
}

/** Resolve whether the business's tier allows Prospecting at all. */
export async function prospectingAllowedForBusiness(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<boolean> {
  return prospectingAllowedForTier(await prospectingTierForBusiness(businessId, client));
}

/** Resolve whether this business must type a footer postal address. */
export async function postalAddressRequiredForBusiness(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<boolean> {
  return postalAddressRequiredForTier(await prospectingTierForBusiness(businessId, client));
}
