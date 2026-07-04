/**
 * Scheduled + template SMS is a Standard-tier perk.
 *
 * Starter tenants send texts in the moment; queuing sends for later and
 * saving reusable templates is part of the Standard/Enterprise feature gap
 * (fleet-economics tier relaunch). The gate lives server-side so every
 * templates/schedule API route enforces it regardless of what the UI shows.
 * The dispatch sweep re-checks tier at send time, so a downgrade between
 * scheduling and dispatch also voids the perk.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const SMS_TOOLS_UPGRADE_MESSAGE =
  "Scheduled texts and saved templates are a Standard plan perk. Upgrade to queue messages and reuse templates.";

/** Furthest-out send time we accept (guards typo'd years, keeps queues sane). */
export const SCHEDULED_SMS_MAX_DAYS_AHEAD = 90;

export function smsToolsAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}

/**
 * Resolve whether the business's tier allows the SMS tools. Throws on lookup
 * failure (routes surface it via handleRouteError as a 500).
 */
export async function smsToolsAllowedForBusiness(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`smsToolsAllowedForBusiness: ${error.message}`);
  return smsToolsAllowedForTier((data as { tier?: string } | null)?.tier);
}
