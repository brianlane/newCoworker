/**
 * CI live-e2e mode — the admin cost toggle for the paid Gemini e2e suite.
 *
 * Two modes, stored as an admin_platform_settings row (key → jsonb string)
 * so flipping it needs no deploy:
 *
 *  - "per-change" (default): the CI e2e job runs the scoped live suite on
 *    PRs and pushes to main (`.github/scripts/e2e-scope.sh` decides how
 *    much), and the nightly workflow is a drift safety net.
 *  - "nightly-only": the CI e2e job skips ALL paid model calls (the job
 *    still enforces the merge gate and reports SUCCESS — the merge policy
 *    treats a skipped check as blocking); live coverage comes exclusively
 *    from the nightly full run, which emails the admin on failure.
 *
 * GitHub Actions reads the mode through GET /api/public/ci-e2e-mode (no
 *auth — the value is operational and non-sensitive) and FAILS OPEN to
 * "per-change" on any error, so an app outage can never silently drop the
 * merge-time suite while the admin believes it is on.
 */

import {
  getAdminPlatformSetting,
  upsertAdminPlatformSetting
} from "@/lib/admin/platform-settings";
import type { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const CI_E2E_MODE_KEY = "ci_e2e_mode";

export const CI_E2E_MODES = ["per-change", "nightly-only"] as const;
export type CiE2eMode = (typeof CI_E2E_MODES)[number];

/** Anything unrecognized (missing row, legacy junk) reads as the default. */
export function parseCiE2eMode(value: unknown): CiE2eMode {
  return value === "nightly-only" ? "nightly-only" : "per-change";
}

export async function getCiE2eMode(client?: SupabaseClient): Promise<CiE2eMode> {
  return parseCiE2eMode(await getAdminPlatformSetting(CI_E2E_MODE_KEY, client));
}

export async function setCiE2eMode(
  mode: CiE2eMode,
  client?: SupabaseClient
): Promise<void> {
  await upsertAdminPlatformSetting(CI_E2E_MODE_KEY, mode, client);
}
