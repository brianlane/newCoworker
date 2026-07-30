/**
 * Outbound AI calls are a Standard-tier perk.
 *
 * Covers proactive dials: batch `place_ai_call` steps and voice flows with
 * `direction: "outbound"` / `outbound_call` (Place call + scheduled).
 * Inbound voice (answer, ring, transfer) stays on every tier. The gate lives
 * server-side at dial time so Starter cannot ring anyone even if an old flow
 * still contains those steps.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { outboundAiCallsAllowedForTier } from "../../../supabase/functions/_shared/outbound_ai_call_tier";

export const OUTBOUND_AI_CALLS_UPGRADE_MESSAGE =
  "Outbound AI calls are a Standard plan perk. Upgrade to have your coworker call people for you.";

export { outboundAiCallsAllowedForTier };

/**
 * Resolve whether the business's tier allows outbound AI dials. Throws on
 * lookup failure (routes surface it via handleRouteError as a 500).
 */
export async function outboundAiCallsAllowedForBusiness(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`outboundAiCallsAllowedForBusiness: ${error.message}`);
  return outboundAiCallsAllowedForTier((data as { tier?: string } | null)?.tier);
}
