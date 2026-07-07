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

export type VpsSize = "kvm1" | "kvm2" | "kvm4" | "kvm8";

/** All valid sizes, for validation + UI pickers. */
export const VPS_SIZES: readonly VpsSize[] = ["kvm1", "kvm2", "kvm4", "kvm8"] as const;

/** Runtime narrowing used by every raw-DB-value resolver below. */
export function isVpsSize(value: unknown): value is VpsSize {
  return value === "kvm1" || value === "kvm2" || value === "kvm4" || value === "kvm8";
}

/**
 * Tier → hardware mapping, used when a business has no explicit pin.
 *
 * standard → kvm2 (Jul 2026 flip): the June 2026 KVM2 experiment + Amy's
 * live cutover proved the full standard feature set — render sidecar,
 * 20-concurrent-call load test, llama3.2:3b local fallback — runs on KVM2
 * (~$24.49/mo vs $73.99 for KVM8, a ~$49.50/mo margin gain per tenant).
 * KVM8 remains available as a per-business `vps_size` escalation pin for
 * tenants with sustained load. Existing standard tenants are unaffected:
 * already-provisioned boxes resolve through `resolveDeployedVpsSize`,
 * whose null-pin fallback stays kvm8 for standard.
 *
 * enterprise → kvm8: enterprise deals are custom-priced, so margin never
 * forces the smaller box; default to the largest SKU and let the admin pin
 * `businesses.vps_size` down (KVM2 is validated for the full standard
 * feature set) when a deal calls for it. On the box, enterprise runs the
 * STANDARD deploy profile (see `resolveBoxTier` in
 * src/lib/provisioning/orchestrate.ts) — entitlements stay on the tier.
 */
export const DEFAULT_TIER_VPS_SIZE: Record<
  "starter" | "standard" | "enterprise",
  VpsSize
> = {
  starter: "kvm1",
  standard: "kvm2",
  enterprise: "kvm8"
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
  tier: "starter" | "standard" | "enterprise",
  override?: string | null
): VpsSize {
  if (isVpsSize(override)) return override;
  return DEFAULT_TIER_VPS_SIZE[tier];
}

/**
 * Hardware size of an ALREADY-PROVISIONED box (fleet redeploys, migrations —
 * anything that pushes a deploy profile onto existing hardware).
 *
 * Differs from {@link resolveVpsSize} only in the null-pin fallback: a
 * business with no `vps_size` pin predates pin persistence (the
 * orchestrator now pins every new provision), which means it was
 * provisioned when starter⇒KVM2 — so its box IS a kvm2 and carries the
 * local Ollama model. Resolving it to the new kvm1 default would stamp a
 * no-Ollama deploy profile onto Ollama hardware and contradict
 * `tenantHasLocalModel` (which also treats null as legacy kvm2/kvm8).
 *
 * Enterprise deploys post-date pin persistence (the tier was un-provisionable
 * before Jul 2026), so every enterprise box carries an explicit pin and the
 * kvm8 fallback here is theoretical.
 */
export function resolveDeployedVpsSize(
  tier: "starter" | "standard" | "enterprise",
  override?: string | null
): VpsSize {
  if (isVpsSize(override)) return override;
  return tier === "starter" ? "kvm2" : "kvm8";
}

/**
 * Parse a Hostinger VM detail's `plan` label ("KVM 2", "KVM 8"…) into a
 * {@link VpsSize}. Null for anything unrecognized (unknown SKU, missing
 * field), so callers can fall back to their own default. Used to label a
 * released box by its ACTUAL hardware when it was never inventory-tracked.
 */
export function vpsSizeFromHostingerPlan(plan: string | null | undefined): VpsSize | null {
  const m = /kvm\s*([1248])\b/i.exec(plan ?? "");
  return m ? (`kvm${m[1]}` as VpsSize) : null;
}

/**
 * Whether this hardware size carries a local Ollama model that chat/SMS can
 * degrade to once the shared AI spend cap trips. KVM1 (1 vCPU / 4GB) does
 * not: bootstrap skips the Ollama install entirely, so over-cap turns must
 * REFUSE (clear "budget used up" behavior) instead of routing to a local
 * agent that doesn't exist. kvm2 and kvm4 (4 vCPU / 16GB) carry the
 * llama3.2:3b fallback; only kvm8 carries qwen3:4b-instruct.
 */
export function vpsSizeHasLocalModel(size: VpsSize): boolean {
  return size !== "kvm1";
}
