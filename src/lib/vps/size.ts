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
 * The July 2026 KVM1 smoke (fleet economics Phase E, VM 1806097) proved the
 * starter stack fits on KVM1 (1 vCPU / 4GB) with Gemini-only AI: 1.1GB used
 * at idle with the full stack up, voice 2-concurrent PASS, owner chat 1.7s.
 * KVM1 is now the starter default (~$8/mo vs ~$19 for KVM2). KVM1 ships NO
 * local Ollama model — when the shared AI budget fuse trips, AI replies stop
 * until the period resets instead of degrading to a local model (decision:
 * Brian, Jul 2026).
 *
 * `businesses.vps_size` (nullable) pins a business to a specific box size.
 * Null means "tier default", which now maps starter → kvm1. Existing starter
 * tenants provisioned on KVM2 hardware carry an explicit `vps_size = 'kvm2'`
 * pin, so the default flip changes no already-provisioned tenant.
 */

export type VpsSize = "kvm1" | "kvm2" | "kvm8";

/** Tier → hardware mapping, used when a business has no explicit pin. */
export const DEFAULT_TIER_VPS_SIZE: Record<"starter" | "standard", VpsSize> = {
  starter: "kvm1",
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
  if (override === "kvm1" || override === "kvm2" || override === "kvm8") return override;
  return DEFAULT_TIER_VPS_SIZE[tier];
}

/**
 * Whether this hardware size carries a local Ollama model that chat/SMS can
 * degrade to once the shared AI spend cap trips. KVM1 (1 vCPU / 4GB) does
 * not: bootstrap skips the Ollama install entirely, so over-cap turns must
 * REFUSE (clear "budget used up" behavior) instead of routing to a local
 * agent that doesn't exist.
 */
export function vpsSizeHasLocalModel(size: VpsSize): boolean {
  return size !== "kvm1";
}
