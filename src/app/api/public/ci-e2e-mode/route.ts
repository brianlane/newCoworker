/**
 * CI-readable live-e2e mode — consumed by .github/scripts/e2e-scope.sh at
 * the start of every e2e job to decide whether the paid model calls run
 * per change or only on the nightly cron.
 *
 * Deliberately UNAUTHENTICATED: GitHub Actions is the caller and the value
 * is a non-sensitive operational flag (it reveals nothing about tenants or
 * the platform beyond "how often does CI run its AI tests"). Read-only,
 * never cached (the admin expects a flip to apply to the next run), and on
 * ANY server error the caller fails open to "per-change" — an app outage
 * can never silently drop merge-time coverage.
 */

import { NextResponse } from "next/server";
import { getCiE2eMode } from "@/lib/admin/ci-e2e-mode";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const mode = await getCiE2eMode();
    return NextResponse.json(
      { mode },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    logger.error("ci-e2e-mode read failed", {
      errorMessage: err instanceof Error ? err.message : String(err)
    });
    // 500 (not a default-mode 200) so the CI side's fail-open is explicit
    // in ITS logs rather than masked by a healthy-looking response.
    return NextResponse.json({ error: "unavailable" }, { status: 500 });
  }
}
