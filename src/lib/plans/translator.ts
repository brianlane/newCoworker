/**
 * Live translator mode is a Standard-tier perk.
 *
 * When armed, the AI stays on a transferred call interpreting both legs,
 * which double-meters Gemini Live for the whole human conversation. Starter's
 * 25 included voice minutes evaporate quickly. The gate lives server-side
 * (same pattern as src/lib/plans/sms-tools.ts) so answer-time arming, admin
 * settings writes, and the voice bridge all refuse Starter regardless of a
 * leftover `translator_mode_enabled` flag.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { translatorAllowedForTier } from "../../../supabase/functions/_shared/translator_tier";

export const TRANSLATOR_UPGRADE_MESSAGE =
  "Live translator mode is a Standard plan perk. Upgrade to keep your coworker on the line interpreting after a transfer.";

export { translatorAllowedForTier };

/**
 * Resolve whether the business's tier allows live translator mode. Throws on
 * lookup failure (routes surface it via handleRouteError as a 500).
 */
export async function translatorAllowedForBusiness(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`translatorAllowedForBusiness: ${error.message}`);
  return translatorAllowedForTier((data as { tier?: string } | null)?.tier);
}
