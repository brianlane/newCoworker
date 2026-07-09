/**
 * OVH VPS plan mapping for the Canada (Beauharnois) provider path.
 *
 * `VpsSize` is the platform's hardware axis (src/lib/vps/size.ts); this
 * module maps it onto OVH plan codes the order cart accepts. Purchases go
 * through the OVHcloud US entity (the platform's business is US-based),
 * whose catalog sells the `-ca` suffixed codes with the Beauharnois (BHS)
 * datacenter — verified against the live `api.us.ovhcloud.com` catalog,
 * Jul 2026. OVH renames SKUs across catalog generations (like Hostinger
 * does), so:
 *
 *   - The defaults below are the cheapest live `-ca` codes meeting each
 *     KVM profile's vCPU/RAM/disk floor (kvm4 skips `vps-2027-model3-ca`
 *     because 12 GB is under the 16 GB floor; kvm8 uses the 2026-gen
 *     model5 because it is both larger and cheaper than the closest
 *     "elite" code).
 *   - EVERY code is overridable via env (OVH_PLAN_CODE_KVM1..KVM8) so a
 *     catalog rename is an env change, not a deploy.
 *   - `debug/ovh-catalog.ts` audits the live catalog and reports whether
 *     each mapped code (default or override) exists, offers BHS + Ubuntu
 *     24.04, and what it costs — run it BEFORE the first real purchase and
 *     after any OVH catalog announcement.
 */

import type { VpsSize } from "@/lib/vps/size";

/**
 * Beauharnois — OVH's Quebec DC; the whole point of the Canada option.
 * Uppercase to match the catalog's `vps_datacenter` configuration values
 * on the US endpoint ("BHS"); compare case-insensitively when auditing.
 */
export const OVH_DATACENTER_CANADA = "BHS";

/** Order-cart duration/pricing defaults: monthly, standard pricing. */
export const OVH_DEFAULT_DURATION = "P1M";
export const OVH_DEFAULT_PRICING_MODE = "default";

/**
 * `ovhSubsidiary` for cart/catalog calls. "US" matches the OVHcloud US
 * account that owns the API credentials; override via OVH_SUBSIDIARY if
 * the account entity ever changes.
 */
export function ovhSubsidiary(env: Record<string, string | undefined> = process.env): string {
  const override = env.OVH_SUBSIDIARY;
  if (typeof override === "string" && override.trim().length > 0) return override.trim();
  return "US";
}

/**
 * Ubuntu image name fragment used to select the rebuild image from
 * `GET /vps/{serviceName}/images/available` (matched case-insensitively).
 * The fleet is built and tested on Ubuntu 24.04 (see bootstrap.sh).
 */
export const OVH_UBUNTU_IMAGE_MATCH = "ubuntu 24.04";

/**
 * Default plan codes per hardware size. Verify with debug/ovh-catalog.ts
 * against the live OVHcloud US catalog before first purchase — see module doc.
 */
const DEFAULT_PLAN_CODES: Record<VpsSize, string> = {
  // RAM floors must satisfy the profile the box will run (and the BYOS
  // preflight minimums in vps/scripts/byos-preflight.sh): kvm1 ≈ 4GB,
  // kvm2 ≈ 8GB, kvm4 ≈ 16GB, kvm8 ≈ 32GB. Verified against the live
  // OVHcloud US catalog (Jul 2026); monthly USD, all BHS-capable:
  //   vps-2027-model1-ca  2 vCPU /  4GB /  40GB  $5.35
  //   vps-2027-model2-ca  4 vCPU /  8GB /  75GB  $10.00
  //   vps-2027-model4-ca  8 vCPU / 24GB / 200GB  $27.50
  //   vps-2025-model5-ca 16 vCPU / 64GB / 350GB  $64.50
  kvm1: "vps-2027-model1-ca",
  kvm2: "vps-2027-model2-ca",
  kvm4: "vps-2027-model4-ca",
  kvm8: "vps-2025-model5-ca"
};

const ENV_OVERRIDES: Record<VpsSize, string> = {
  kvm1: "OVH_PLAN_CODE_KVM1",
  kvm2: "OVH_PLAN_CODE_KVM2",
  kvm4: "OVH_PLAN_CODE_KVM4",
  kvm8: "OVH_PLAN_CODE_KVM8"
};

/**
 * Resolve the OVH plan code for a hardware size: env override first
 * (catalog renames are env changes), then the audited default.
 */
export function ovhPlanCodeForSize(
  size: VpsSize,
  env: Record<string, string | undefined> = process.env
): string {
  const override = env[ENV_OVERRIDES[size]];
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  return DEFAULT_PLAN_CODES[size];
}
