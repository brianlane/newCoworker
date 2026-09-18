/**
 * Owner-facing "coworker is live" gate for `/onboard/success`.
 *
 * Client-safe (no Node/server imports). `src/lib/provisioning/progress.ts`
 * cannot be imported from a `"use client"` page because it pulls in the
 * service-role client. The flags this helper reads are the same ones
 * `GET /api/provisioning/status` already computes from
 * `shouldShowProvisioningProgress`:
 *
 * - `complete`: dashboard would hide the in-progress bar
 * - `failed`: latest provisioning row is an error (widget shows the
 *   failure card instead)
 *
 * `businesses.status === "online"` is not this gate. The orchestrator
 * flips the row online before (and even without) recording 100%, so the
 * dashboard can still show ~40% for minutes after status is online.
 */

export type ProvisioningStatusLivePayload = {
  complete?: boolean;
  failed?: boolean;
  percent?: number;
};

/**
 * True when `/api/provisioning/status` says the owner UI is dashboard-ready
 * and not in the terminal failure state. Unexported: knip --production
 * treats a test-only export as dead code wearing coverage.
 */
function isProvisioningStatusLive(
  provisioning: ProvisioningStatusLivePayload | null | undefined
): boolean {
  return provisioning?.complete === true && provisioning?.failed !== true;
}

/**
 * Decision used by `/onboard/success` after a poll tick.
 *
 * `businessStatus` is accepted so callers do not quietly fall back to
 * `status === "online"`. It is not part of the live gate: the provisioning
 * `complete` flag already requires a running business except on error.
 */
export function onboardSuccessLiveFromPoll(input: {
  businessStatus?: string | null;
  provisioning: ProvisioningStatusLivePayload | null | undefined;
}): boolean {
  return isProvisioningStatusLive(input.provisioning);
}
