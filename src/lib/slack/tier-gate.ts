/**
 * The Slack integration is a STANDARD+ feature, same bar as the Messenger /
 * Instagram / WhatsApp AI replies, the website chat widget, and external
 * webhooks.
 *
 * The gate lives server-side at every ingress (connect route, reply worker,
 * alert delivery) so a starter tenant, or a tenant that downgrades after
 * connecting, keeps its stored connection row but the surface stops acting
 * until they upgrade again, without deleting anything.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const SLACK_UPGRADE_MESSAGE =
  "The Slack integration is available on Standard and Enterprise plans.";

export function slackAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}

/** DB-resolving twin for routes that only have a business id. */
export async function slackAllowedForBusiness(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`slackAllowedForBusiness: ${error.message}`);
  return slackAllowedForTier((data as { tier?: string | null } | null)?.tier);
}
