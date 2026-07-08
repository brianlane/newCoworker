/**
 * Placement-driven residency enforcement (Enterprise BYOS + Canada).
 *
 * The whole point of a customer-owned (BYOS) or Canadian (region 'ca') box
 * is that the tenant's customer content physically lives ON that box — a
 * BYOS/CA tenant whose `data_residency_mode` is still 'supabase' would have
 * their own hardware while every contact/transcript/email sits in central
 * (US) Supabase, silently defeating the deal's compliance premise.
 *
 * Enforced at PROVISION time (the orchestrator, plus a friendlier
 * pre-check in the BYOS enrollment route): the admin must flip residency
 * to at least 'dual' BEFORE provisioning, so the same deploy that stands
 * the box up also stands up the on-box datastore, data-api hostname, and
 * backup timer. The runbook then proceeds dual → parity → vps → purge as
 * documented in README §Data residency.
 */

import { resolveVpsProvider, resolveVpsRegion } from "@/lib/vps/provider";

export class ResidencyPlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResidencyPlacementError";
  }
}

/**
 * True when this provider/region placement REQUIRES the residency program:
 * customer-owned boxes (byos) and Canadian placements (region 'ca',
 * whichever provider runs the box).
 */
export function placementRequiresResidency(
  provider: string | null | undefined,
  region: string | null | undefined
): boolean {
  return resolveVpsProvider(provider) === "byos" || resolveVpsRegion(region) === "ca";
}

/**
 * Throws {@link ResidencyPlacementError} when a BYOS/CA business is about
 * to provision with residency still off. Pure — callers supply the raw
 * business-row fields.
 */
export function assertResidencyForPlacement(business: {
  vps_provider?: string | null;
  vps_region?: string | null;
  data_residency_mode?: string | null;
}): void {
  if (!placementRequiresResidency(business.vps_provider, business.vps_region)) return;
  const mode = business.data_residency_mode ?? "supabase";
  if (mode !== "supabase") return;
  const placement =
    resolveVpsProvider(business.vps_provider) === "byos"
      ? "a customer-owned (BYOS) box"
      : "a Canadian-region box";
  throw new ResidencyPlacementError(
    `data_residency_mode is 'supabase' but this tenant provisions onto ${placement} — ` +
      "content would stay in central (US) Supabase, defeating the placement's compliance premise. " +
      "Flip data residency to 'dual' first (admin business page → Data residency), then provision; " +
      "the deploy will stand up the on-box datastore + backups in the same run."
  );
}
