/**
 * Data residency is an ENTERPRISE-tier, opt-in feature.
 *
 * Each opted-in enterprise tenant's customer content physically lives on
 * their own VPS instead of central Supabase (the "your data on your own
 * server" compliance story). The gate lives server-side so every write to
 * `businesses.data_residency_mode` enforces it regardless of what the UI
 * shows — same pattern as the BYON tier gate (src/lib/byon/tier-gate.ts).
 *
 * Default is 'supabase' for every business; nothing in the residency code
 * path activates unless an admin flips an enterprise tenant forward.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const DATA_RESIDENCY_MODES = ["supabase", "dual", "vps"] as const;
export type DataResidencyMode = (typeof DATA_RESIDENCY_MODES)[number];

export function isDataResidencyMode(value: unknown): value is DataResidencyMode {
  return value === "supabase" || value === "dual" || value === "vps";
}

export const RESIDENCY_TIER_MESSAGE =
  "Data residency is an Enterprise plan feature. Only enterprise tenants can move content onto their own server.";

export function residencyAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "enterprise";
}

export class ResidencyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResidencyValidationError";
  }
}

/**
 * Throws {@link ResidencyValidationError} when the business is not on the
 * enterprise tier. Flipping BACK to the 'supabase' default is always
 * allowed regardless of tier, so a downgraded tenant can never be wedged
 * in a residency mode its plan no longer supports.
 */
export async function assertResidencyModeAllowed(
  businessId: string,
  mode: DataResidencyMode,
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>
): Promise<void> {
  if (mode === "supabase") return;
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`assertResidencyModeAllowed: ${error.message}`);
  if (!residencyAllowedForTier((data as { tier?: string } | null)?.tier)) {
    throw new ResidencyValidationError(RESIDENCY_TIER_MESSAGE);
  }
}
