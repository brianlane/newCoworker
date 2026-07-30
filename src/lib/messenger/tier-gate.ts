/**
 * Messenger / Instagram DM / WhatsApp conversational AI is a STANDARD+ feature.
 *
 * Same product class as the website chat widget (src/lib/webchat/tier-gate.ts):
 * always-on Gemini replies with booking and lead-capture tools. External
 * webhook *flow* events for first contact are already gated separately
 * (src/lib/plans/webhooks.ts). This gate covers the reply engine only: inbox
 * ingest and owner manual send stay available on Starter.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const MESSENGER_TIER_MESSAGE =
  "Automatic Messenger, Instagram, and WhatsApp replies are available on Standard and Enterprise plans.";

export function messengerAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}

export class MessengerTierValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessengerTierValidationError";
  }
}

/** Throws {@link MessengerTierValidationError} when the business is not Standard+. */
export async function assertMessengerAllowed(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`assertMessengerAllowed: ${error.message}`);
  if (!messengerAllowedForTier((data as { tier?: string } | null)?.tier)) {
    throw new MessengerTierValidationError(MESSENGER_TIER_MESSAGE);
  }
}
