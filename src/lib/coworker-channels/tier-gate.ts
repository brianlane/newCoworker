/**
 * One plan gate for every team-chat coworker channel.
 *
 * Same bar as Slack, Messenger, the webchat widget and external webhooks:
 * Standard and up. Shared rather than copied per channel because the copies
 * would only ever agree by hand, and a channel that quietly gated one tier
 * lower would be a pricing bug nobody could see from the settings page.
 *
 * The gate lives server-side at EVERY ingress (the connect route, the reply
 * worker, alert delivery), so a starter tenant, or a tenant that downgrades
 * after connecting, keeps its stored connection row while the surface stops
 * acting. Nothing is deleted, so an upgrade resumes without a reconnect.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export function coworkerChannelAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}

/** DB-resolving twin for the paths that only have a business id. */
export async function coworkerChannelAllowedForBusiness(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`coworkerChannelAllowedForBusiness: ${error.message}`);
  return coworkerChannelAllowedForTier((data as { tier?: string | null } | null)?.tier);
}
