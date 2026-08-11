/**
 * The HIPAA lane is an ENTERPRISE-tier, opt-in feature.
 *
 * Turning it on is not a feature flag, it is a commitment to a different and
 * more expensive operating posture: a Business Associate Agreement with every
 * subprocessor that can touch PHI, a placement off the default fleet, and
 * paid compliance add-ons on the platform accounts. Those costs are org-level
 * and fixed, so the gate is deliberately narrow.
 *
 * Same server-side shape as the residency gate
 * (src/lib/residency/tier-gate.ts): every write to `businesses.hipaa_mode`
 * runs through here regardless of what the UI offers, and the DB column stays
 * tier-agnostic so a future tier expansion is a code change, not a migration.
 *
 * Default is false for every business; nothing in the HIPAA code path
 * activates unless an admin flips an enterprise tenant on.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const HIPAA_TIER_MESSAGE =
  "The HIPAA lane is an Enterprise plan feature. Only enterprise tenants can enable it.";

export function hipaaAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "enterprise";
}

export class HipaaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HipaaValidationError";
  }
}

/**
 * Throws {@link HipaaValidationError} when the business is not on the
 * enterprise tier. Turning HIPAA mode OFF is always allowed regardless of
 * tier, so a downgraded tenant can never be wedged in a mode its plan no
 * longer supports. Mirrors `assertResidencyModeAllowed`.
 */
export async function assertHipaaModeAllowed(
  businessId: string,
  enabled: boolean,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<void> {
  if (!enabled) return;
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`assertHipaaModeAllowed: ${error.message}`);
  if (!hipaaAllowedForTier((data as { tier?: string } | null)?.tier)) {
    throw new HipaaValidationError(HIPAA_TIER_MESSAGE);
  }
}
