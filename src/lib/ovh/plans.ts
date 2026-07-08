/**
 * OVH VPS plan mapping for the Canada (Beauharnois) provider path.
 *
 * `VpsSize` is the platform's hardware axis (src/lib/vps/size.ts); this
 * module maps it onto OVH plan codes the order cart accepts. OVH renames
 * SKUs across catalog generations (like Hostinger does), so:
 *
 *   - The defaults below target the 2025/2026 "vps-le" (Linux Essential)
 *     lineup sized to match each KVM profile's vCPU/RAM floor.
 *   - EVERY code is overridable via env (OVH_PLAN_CODE_KVM1..KVM8) so a
 *     catalog rename is an env change, not a deploy.
 *   - `debug/ovh-catalog.ts` audits the live `ovh-ca` catalog and reports
 *     whether each mapped code (default or override) exists and what it
 *     costs — run it BEFORE the first real purchase and after any OVH
 *     catalog announcement.
 */

import type { VpsSize } from "@/lib/vps/size";

/** Beauharnois — OVH's Quebec DC; the whole point of the Canada option. */
export const OVH_DATACENTER_CANADA = "bhs";

/** Order-cart duration/pricing defaults: monthly, standard pricing. */
export const OVH_DEFAULT_DURATION = "P1M";
export const OVH_DEFAULT_PRICING_MODE = "default";

/**
 * Ubuntu image name fragment used to select the rebuild image from
 * `GET /vps/{serviceName}/images/available` (matched case-insensitively).
 * The fleet is built and tested on Ubuntu 24.04 (see bootstrap.sh).
 */
export const OVH_UBUNTU_IMAGE_MATCH = "ubuntu 24.04";

/**
 * Default plan codes per hardware size. Verify with debug/ovh-catalog.ts
 * against the live ovh-ca catalog before first purchase — see module doc.
 */
const DEFAULT_PLAN_CODES: Record<VpsSize, string> = {
  // RAM floors must satisfy the profile the box will run (and the BYOS
  // preflight minimums in vps/scripts/byos-preflight.sh): kvm1 ≈ 4GB,
  // kvm2 ≈ 8GB, kvm4 ≈ 16GB, kvm8 ≈ 32GB. OVH "vps-le" codes encode
  // vCPU-RAM-disk; kvm1 maps to a 4GB SKU (a 2GB box cannot host even the
  // Gemini-only starter stack).
  kvm1: "vps-le-2-4-80",
  kvm2: "vps-le-2-8-80",
  kvm4: "vps-le-4-16-160",
  kvm8: "vps-le-8-32-320"
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
