/**
 * External webhooks are a Standard-tier perk.
 *
 * "Webhooks" here means every EXTERNAL event source that can start a
 * `webhook`-channel AiFlow or consume the public API: Zapier/Make bridges on
 * /api/public/v1/*, Meta lead ads, Instagram comments, Messenger/IG DM/
 * WhatsApp first-contact events, Vagaro webhook flow events, and outbound
 * REST-hook deliveries. Internal producers that reuse the same trigger
 * channel (document renewal events, the lead-backlog import, the outreach
 * sweep) are deliberately NOT gated - they are platform features, not
 * webhooks, and keep working on Starter.
 *
 * The gate lives server-side (same pattern as src/lib/plans/sms-tools.ts) so
 * every ingress enforces it regardless of what the UI shows. Delivery paths
 * re-check tier at event time, so a downgrade to starter silently stops
 * webhook traffic without deleting any stored flow or subscription.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { webhooksAllowedForTier } from "../../../supabase/functions/_shared/webhook_tier";

export const WEBHOOKS_UPGRADE_MESSAGE =
  "Webhooks are a Standard plan perk. Upgrade to connect Zapier, Meta lead ads, and other webhook lead sources.";

export { webhooksAllowedForTier };

/**
 * Resolve whether the business's tier allows external webhooks. Throws on
 * lookup failure (routes surface it via handleRouteError as a 500; event
 * paths treat it as a delivery failure and let the sender retry).
 */
export async function webhooksAllowedForBusiness(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`webhooksAllowedForBusiness: ${error.message}`);
  return webhooksAllowedForTier((data as { tier?: string } | null)?.tier);
}
