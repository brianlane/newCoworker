/**
 * Team access (additional logins with roles) is an ENTERPRISE-tier feature.
 *
 * The gate lives server-side so every invite/role write enforces it
 * regardless of what the UI shows — same pattern as the BYON tier gate
 * (src/lib/byon/tier-gate.ts). Revoking access and reading the roster stay
 * allowed on any tier, so a downgraded business can always shed members but
 * never add them.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const TEAM_ACCESS_TIER_MESSAGE =
  "Team access is an Enterprise plan feature. Only enterprise businesses can invite additional logins.";

export function teamAccessAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "enterprise";
}

export class TeamAccessValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamAccessValidationError";
  }
}

/** Throws {@link TeamAccessValidationError} when the business is not enterprise tier. */
export async function assertTeamAccessAllowed(
  businessId: string,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`assertTeamAccessAllowed: ${error.message}`);
  if (!teamAccessAllowedForTier((data as { tier?: string } | null)?.tier)) {
    throw new TeamAccessValidationError(TEAM_ACCESS_TIER_MESSAGE);
  }
}
