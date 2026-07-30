/**
 * Email campaigns and Instagram publishing are a Standard-tier perk.
 *
 * Bulk Resend sends and Graph API publish cron are marketing automation, not
 * the core AI phone coworker. The gate lives server-side (same pattern as
 * src/lib/plans/sms-tools.ts) so create/schedule routes and both sweeps refuse
 * Starter regardless of what the UI shows. Cancelling a leftover scheduled
 * item still works so a downgrade can stop sends.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const MARKETING_AUTOMATION_UPGRADE_MESSAGE =
  "Email campaigns and Instagram publishing are a Standard plan perk. Upgrade to schedule bulk email and social posts.";

export function marketingAutomationAllowedForTier(
  tier: string | null | undefined
): boolean {
  return tier === "standard" || tier === "enterprise";
}

export async function marketingAutomationAllowedForBusiness(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`marketingAutomationAllowedForBusiness: ${error.message}`);
  return marketingAutomationAllowedForTier((data as { tier?: string } | null)?.tier);
}
