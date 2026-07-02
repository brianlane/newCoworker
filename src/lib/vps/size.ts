/**
 * VPS hardware size, decoupled from the plan tier.
 *
 * `tier` is the ENTITLEMENT axis (voice minutes, SMS caps, concurrency, AI
 * budget, render sidecar). `vps_size` is the HARDWARE axis (which Hostinger
 * SKU we rent, ZRAM, Ollama model + parallelism). Historically the two were
 * conflated: starter ⇒ KVM2, standard ⇒ KVM8. The June 2026 KVM2 experiment
 * (see debug/README.md §KVM2) proved the KVM2 box can run the full standard
 * feature set — including the aiflow-render sidecar — so a Standard tenant
 * can be hosted on KVM2 hardware with zero functional change.
 *
 * `businesses.vps_size` (nullable) pins a business to a specific box size.
 * Null means "tier default", which preserves the historical mapping so no
 * existing tenant changes hardware until an operator opts them in.
 */

export type VpsSize = "kvm2" | "kvm8";

/** Historical tier → hardware mapping, used when a business has no explicit pin. */
export const DEFAULT_TIER_VPS_SIZE: Record<"starter" | "standard", VpsSize> = {
  starter: "kvm2",
  standard: "kvm8"
};

/**
 * Resolve the effective hardware size for a business.
 *
 * `override` is the raw `businesses.vps_size` value (or an explicit caller
 * choice). Anything other than a valid size — null, undefined, or a corrupt
 * string — falls back to the tier default, so a bad DB value can never brick
 * provisioning.
 */
export function resolveVpsSize(
  tier: "starter" | "standard",
  override?: string | null
): VpsSize {
  if (override === "kvm2" || override === "kvm8") return override;
  return DEFAULT_TIER_VPS_SIZE[tier];
}
