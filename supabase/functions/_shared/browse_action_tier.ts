/**
 * Canonical tier predicate for AiFlow `browse_action` (Standard+).
 *
 * Click/fill automation needs the per-tenant render sidecar, which
 * provisioning already omits on Starter. This predicate is the shared
 * source of truth for save-time refuse, UI filtering, and worker fail
 * messages so Starter never gets a silent missing-sidecar failure.
 */
export const BROWSE_ACTION_UPGRADE_MESSAGE =
  "Browser actions (click and fill on websites) are a Standard plan perk. Upgrade to operate sites like a person.";

export function browseActionAllowedForTier(
  tier: string | null | undefined
): boolean {
  return tier === "standard" || tier === "enterprise";
}
