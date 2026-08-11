/**
 * Placement enforcement for the HIPAA lane.
 *
 * A HIPAA tenant's box must sit somewhere a Business Associate Agreement can
 * actually cover, and the default fleet is not such a place. Hostinger's
 * hosting agreement says it plainly: its services "are not intended to provide
 * a PCI or HIPAA compliant environment and therefore should not be used or
 * considered as one", and they sign no BAA. Provisioning a HIPAA tenant there
 * would put PHI on infrastructure whose own contract forbids it.
 *
 * Eligible placements today: **BYOS only**. A customer-owned box is the one
 * case where the covered entity already holds whatever agreement its own
 * infrastructure needs, so we are not relying on a platform vendor we have no
 * BAA with.
 *
 * Deliberately NOT eligible yet:
 *   - 'hostinger': see above, contractually excluded.
 *   - 'ovh': that placement exists for Canadian residency (Beauharnois QC).
 *     We hold no OVH BAA, and a Canadian box for a US covered entity adds
 *     cross-border exposure the deal would have to disclose separately.
 *
 * Deliberately NOT added as a provider yet: a platform-owned Google Compute
 * Engine placement, which is where this is heading (Compute Engine is on
 * Google Cloud's HIPAA covered-products list, and one BAA would cover both the
 * box and the model surface). Adding 'gcp' to VPS_PROVIDERS before the
 * provisioning lifecycle exists would create a placement an admin can select
 * and provisioning cannot fulfill. That value lands with its implementation.
 *
 * Enforced at the same two points as the residency placement gate
 * (src/lib/residency/enforce.ts): the provisioning orchestrator, plus a
 * friendlier pre-check in the BYOS enrollment route.
 */

import { resolveVpsProvider, type VpsProvider } from "@/lib/vps/provider";

export class HipaaPlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HipaaPlacementError";
  }
}

/** Placements a HIPAA tenant may provision onto. */
export const HIPAA_ELIGIBLE_PROVIDERS: readonly VpsProvider[] = ["byos"];

export function hipaaPlacementAllowed(provider: string | null | undefined): boolean {
  return HIPAA_ELIGIBLE_PROVIDERS.includes(resolveVpsProvider(provider));
}

/** True only when the tenant has actually opted into the HIPAA lane. */
export function hipaaModeEnabled(value: unknown): boolean {
  return value === true;
}

/**
 * Throws {@link HipaaPlacementError} when a HIPAA tenant is about to
 * provision onto a placement no BAA can cover, or with content still sitting
 * in central Supabase. Pure: callers supply the raw business-row fields.
 *
 * The residency requirement is stated here explicitly rather than leaned on
 * transitively. Today every eligible placement is BYOS, which
 * `assertResidencyForPlacement` already forces to at least 'dual', so the
 * second check is redundant. It stops being redundant the moment a
 * platform-owned HIPAA placement is added, and a compliance gate should not
 * depend on another gate's current membership list.
 */
export function assertHipaaPlacement(business: {
  hipaa_mode?: boolean | null;
  vps_provider?: string | null;
  data_residency_mode?: string | null;
}): void {
  if (!hipaaModeEnabled(business.hipaa_mode)) return;

  if (!hipaaPlacementAllowed(business.vps_provider)) {
    throw new HipaaPlacementError(
      `hipaa_mode is on but this tenant provisions onto a '${resolveVpsProvider(business.vps_provider)}' box, ` +
        "which no Business Associate Agreement covers (Hostinger's hosting agreement excludes HIPAA outright). " +
        "Move the tenant to a customer-owned (BYOS) placement before provisioning, or turn hipaa_mode off."
    );
  }

  const mode = business.data_residency_mode ?? "supabase";
  if (mode === "supabase") {
    throw new HipaaPlacementError(
      "hipaa_mode is on but data_residency_mode is still 'supabase', so PHI would live in central US Supabase " +
        "outside the tenant's own box. Flip data residency to 'dual' first (admin business page, Data residency), " +
        "then provision."
    );
  }
}
