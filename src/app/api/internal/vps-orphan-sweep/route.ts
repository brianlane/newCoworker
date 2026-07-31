/**
 * Internal, cron-triggered fleet orphan sweep.
 *
 * Call chain: pg_cron (daily) → Edge fn `vps-orphan-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Finds Hostinger VMs with no `vps_inventory` row, pools the ones that were
 * never set up and belong to nobody (auto-renew off, so they lapse unless
 * adopted), and reports the rest. See src/lib/vps/orphan-sweep.ts.
 *
 * `?dryRun=1` finds and reports without changing anything, for running the
 * sweep by hand against the live account before trusting it on a schedule.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse, handleRouteError } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { listBusinesses } from "@/lib/db/businesses";
import { listVpsInventory, releaseVpsToPool } from "@/lib/db/vps-inventory";
import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";
import { runOrphanSweep } from "@/lib/vps/orphan-sweep";
import { sendOpsOrphanSweepEmail } from "@/lib/email/ops-notify";

export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const hostinger = new HostingerClient({
      /* c8 ignore next 2 -- trivial env-default fallbacks */
      baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
      token: process.env.HOSTINGER_API_TOKEN ?? ""
    });
    const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";

    const result = await runOrphanSweep(
      {
        listVirtualMachines: () => hostinger.listVirtualMachines(),
        listVpsInventory,
        listBusinesses,
        listBillingSubscriptions: () => hostinger.listBillingSubscriptions(),
        getVirtualMachine: (vmId) => hostinger.getVirtualMachine(vmId),
        disableBillingAutoRenewal: (id) => hostinger.disableBillingAutoRenewal(id),
        releaseVpsToPool,
        sendOpsEmail: sendOpsOrphanSweepEmail
      },
      { dryRun }
    );

    logger.info("vps orphan sweep complete", {
      checked: result.checked,
      orphaned: result.orphaned,
      pooled: result.pooled,
      reported: result.reported,
      dryRun
    });

    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
