/**
 * The embeddable website chat widget is a STANDARD+ feature.
 *
 * The gate lives server-side so both the owner-facing settings writes AND
 * every public widget call enforce it regardless of what any UI shows —
 * same pattern as the team gate (src/lib/team/tier-gate.ts). A tenant that
 * downgrades to starter keeps its stored settings but the widget stops
 * answering (and settings writes are refused) until they upgrade again.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const WEBCHAT_TIER_MESSAGE =
  "The website chat widget is available on Standard and Enterprise plans.";

export function webchatAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}

export class WebchatTierValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebchatTierValidationError";
  }
}

/** Throws {@link WebchatTierValidationError} when the business is not Standard+. */
export async function assertWebchatAllowed(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`assertWebchatAllowed: ${error.message}`);
  if (!webchatAllowedForTier((data as { tier?: string } | null)?.tier)) {
    throw new WebchatTierValidationError(WEBCHAT_TIER_MESSAGE);
  }
}
