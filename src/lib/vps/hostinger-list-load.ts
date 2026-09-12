/**
 * Opening Hostinger list calls for the two VPS buy-sweeps (contract-upgrade
 * and term-renewal). Both start with Promise.all of listCatalog +
 * listBillingSubscriptions. A 30s catalog timeout used to throw out of that
 * pair, become INTERNAL_SERVER_ERROR, and page ACTION REQUIRED. Sep 11 2026
 * was that path: no box was touched.
 *
 * One immediate retry absorbs a single slow catalog. A second flake is
 * returned as a detail string so the sweep can finish ok:true and the route
 * can apply the System Errors warn-until-repeat rule.
 */

import type { BillingSubscription, CatalogItem } from "@/lib/hostinger/client";
import {
  HOSTINGER_FLAKE_WINDOW_MINUTES,
  hostingerFlakeDetail,
  isHostingerFlakeError,
  retryOnceOnHostingerFlake
} from "@/lib/hostinger/flake";
import type { recordFailure } from "@/lib/db/system-logs";

/**
 * Per-sweep `system_logs.event`. `recordFailure` keys on event + business_id,
 * not source, so the two buy-sweeps must not share one event: a 10:30
 * contract-upgrade warn would otherwise make the 11:00 term-renewal run
 * escalate the same morning.
 */
function hostingerListFlakeLogEvent(sweep: string): string {
  return `${sweep.replace(/-/g, "_")}_hostinger_list_flake`;
}

type HostingerLists = {
  catalog: CatalogItem[];
  billingSubs: BillingSubscription[];
};

type HostingerListLoad =
  | { ok: true; lists: HostingerLists }
  | { ok: false; detail: string };

export async function loadHostingerListsForSweep(deps: {
  listCatalog: () => Promise<CatalogItem[]>;
  listBillingSubscriptions: () => Promise<BillingSubscription[]>;
}): Promise<HostingerListLoad> {
  const attempt = async (): Promise<HostingerLists> => {
    const [catalog, billingSubs] = await Promise.all([
      deps.listCatalog(),
      deps.listBillingSubscriptions()
    ]);
    return { catalog, billingSubs };
  };
  try {
    return { ok: true, lists: await retryOnceOnHostingerFlake(attempt) };
  } catch (err) {
    if (!isHostingerFlakeError(err)) throw err;
    return { ok: false, detail: hostingerFlakeDetail(err) };
  }
}

type SweepListResult = {
  hostingerUnavailable?: string;
  failures: string[];
};

/**
 * First Hostinger list flake in 48h stays out of `failures[]` (watchdog
 * silent). A repeat in the window is copied into `failures[]` so the
 * watchdog pages `hostinger_flake`, not CRASHED / ACTION REQUIRED.
 *
 * Fails loud: a recorder throw escalates, matching recordFailure.
 */
export async function applyHostingerListFlakePaging<T extends SweepListResult>(
  result: T,
  sweep: string,
  recordTransientFailure: typeof recordFailure
): Promise<T> {
  const detail = result.hostingerUnavailable;
  if (!detail) return result;
  let level = "error";
  try {
    level = await recordTransientFailure(
      {
        businessId: null,
        source: sweep,
        event: hostingerListFlakeLogEvent(sweep),
        message: detail
      },
      { windowMinutes: HOSTINGER_FLAKE_WINDOW_MINUTES }
    );
  } catch {
    level = "error";
  }
  if (level !== "error") return result;
  return {
    ...result,
    failures: [...result.failures, `Hostinger list failed: ${detail}`]
  };
}
