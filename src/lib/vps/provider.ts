/**
 * VPS provider axis, decoupled from tier (entitlements) and vps_size
 * (hardware).
 *
 * `businesses.vps_provider` records WHICH provider runs the tenant box:
 *
 *   - 'hostinger' (default) — platform-purchased Hostinger box. The full
 *     historical lifecycle applies: purchase/adopt-first via the
 *     `vps_inventory` pool, Hostinger billing auto-renew management on
 *     cancel, snapshot/stop ops, and the manual hPanel deletion request.
 *   - 'ovh' — platform-purchased OVHcloud box in Beauharnois (Quebec) for
 *     Canadian data residency. None of the Hostinger lifecycle applies.
 *   - 'byos' — customer-owned box enrolled via SSH handover (enterprise
 *     deals). No purchase, no pool, no provider billing; cancel wipes the
 *     box over SSH instead of tearing down a VM.
 *
 * `businesses.vps_region` records WHERE the box physically lives ('us' |
 * 'ca') — the at-rest half of the Canadian PII compliance story.
 *
 * Non-hostinger providers are ENTERPRISE-ONLY, enforced in code exactly
 * like the residency gate (src/lib/residency/tier-gate.ts): the DB columns
 * stay tier-agnostic so a future tier expansion is a code change, not a
 * migration.
 */

export const VPS_PROVIDERS = ["hostinger", "ovh", "byos"] as const;
export type VpsProvider = (typeof VPS_PROVIDERS)[number];

export const VPS_REGIONS = ["us", "ca"] as const;
export type VpsRegion = (typeof VPS_REGIONS)[number];

/** Runtime narrowing for raw DB values. */
export function isVpsProvider(value: unknown): value is VpsProvider {
  return value === "hostinger" || value === "ovh" || value === "byos";
}

export function isVpsRegion(value: unknown): value is VpsRegion {
  return value === "us" || value === "ca";
}

/**
 * Resolve the effective provider from a raw `businesses.vps_provider` value.
 * Anything other than a valid provider — null, undefined, legacy rows
 * pre-dating the column, or a corrupt string — falls back to 'hostinger',
 * so a bad DB value can never route a fleet tenant onto a lifecycle path
 * that skips its Hostinger teardown.
 */
export function resolveVpsProvider(raw: string | null | undefined): VpsProvider {
  if (isVpsProvider(raw)) return raw;
  return "hostinger";
}

/** Same fallback contract as {@link resolveVpsProvider}, for the region axis. */
export function resolveVpsRegion(raw: string | null | undefined): VpsRegion {
  if (isVpsRegion(raw)) return raw;
  return "us";
}

export const VPS_PROVIDER_TIER_MESSAGE =
  "Bring-your-own-server and Canada-region hosting are Enterprise plan features. Only enterprise tenants can run on a non-Hostinger box.";

/**
 * Non-hostinger providers (customer-owned BYOS boxes, OVH Canada boxes) are
 * enterprise-only — same policy shape as `residencyAllowedForTier`.
 */
export function providerAllowedForTier(
  provider: VpsProvider,
  tier: string | null | undefined
): boolean {
  if (provider === "hostinger") return true;
  return tier === "enterprise";
}

export class VpsProviderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VpsProviderValidationError";
  }
}

/**
 * Throws {@link VpsProviderValidationError} when a non-hostinger provider is
 * requested for a non-enterprise tenant. Pure (the caller supplies the tier)
 * so the orchestrator can gate without an extra DB read.
 */
export function assertVpsProviderAllowed(
  provider: VpsProvider,
  tier: string | null | undefined
): void {
  if (!providerAllowedForTier(provider, tier)) {
    throw new VpsProviderValidationError(VPS_PROVIDER_TIER_MESSAGE);
  }
}

/**
 * Whether the Hostinger-specific lifecycle applies to this box: the
 * `vps_inventory` adopt/return pool, Hostinger billing auto-renew ops,
 * snapshot/stop VM ops, and the manual hPanel deletion request email.
 * BYOS/OVH boxes get none of that — their teardown paths are provider-
 * specific (SSH wipe / OVH service termination) and land in later PRs.
 */
export function providerUsesHostingerLifecycle(provider: VpsProvider): boolean {
  return provider === "hostinger";
}
