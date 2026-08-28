/**
 * Web Push is a STANDARD+ feature, the same bar as Slack, the Messenger /
 * Instagram / WhatsApp AI replies, the website chat widget, and external
 * webhooks.
 *
 * The gate lives server-side at every ingress (the subscribe route and
 * delivery), so a starter tenant, or a tenant that downgrades after
 * subscribing, keeps its stored device rows but stops receiving until they
 * upgrade again. Nothing is deleted, so an upgrade restores the channel
 * without every teammate having to re-install.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const PUSH_UPGRADE_MESSAGE =
  "Push notifications are available on Standard and Enterprise plans.";

function pushAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}

/** DB-resolving twin for callers that only have a business id. */
export async function pushAllowedForBusiness(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`pushAllowedForBusiness: ${error.message}`);
  return pushAllowedForTier((data as { tier?: string | null } | null)?.tier);
}
