/**
 * Internal, cron-triggered fleet contract-upgrade sweep.
 *
 * Call chain: pg_cron (daily) → Edge fn `vps-contract-upgrade-sweep` → this
 * route. Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Moves at most one contract tenant per run off short-runway hardware onto a
 * box whose Hostinger term covers the rest of their contract, once their
 * 30-day refund exposure has closed and their current box is inside its
 * renewal window. See src/lib/vps/contract-upgrade-sweep.ts.
 *
 * Deliberately a SEPARATE cron from `vps-term-renewal-sweep`, at a different
 * hour: both sweeps migrate one tenant per run, and sharing a run would let
 * whichever class sorted first starve the other indefinitely.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse, handleRouteError } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { listBusinesses, getBusiness } from "@/lib/db/businesses";
import {
  listBusinessIdsWithLiveSubscription,
  listSubscriptionsByBusinessIds,
  getSubscription,
  updateSubscription
} from "@/lib/db/subscriptions";
import { listCustomerProfilesByIds } from "@/lib/db/customer-profiles";
import { releaseVpsToPool, markVpsNeverRenew } from "@/lib/db/vps-inventory";
import {
  hasActiveVpsMigrationLock,
  tryClaimVpsMigration,
  releaseVpsMigrationLock
} from "@/lib/db/vps-migration-locks";
import { getActiveVpsSshKey } from "@/lib/db/vps-ssh-keys";
import { getLastEnqueuedAtForPurpose } from "@/lib/provisioning/jobs";
import { backupBusinessData, restoreBusinessData } from "@/lib/hostinger/data-migration";
import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";
import { runContractUpgradeSweep } from "@/lib/vps/contract-upgrade-sweep";
import { sendOpsHardwareMigrationEmail } from "@/lib/email/ops-notify";

export const maxDuration = 1800;
export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const hostinger = new HostingerClient({
      /* c8 ignore next 2 -- trivial env-default fallbacks */
      baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
      token: process.env.HOSTINGER_API_TOKEN ?? ""
    });

    const result = await runContractUpgradeSweep({
      listBusinesses,
      listBusinessIdsWithLiveSubscription,
      listSubscriptionsByBusinessIds,
      listCustomerProfilesByIds,
      listCatalog: () => hostinger.listCatalog("VPS"),
      listBillingSubscriptions: () => hostinger.listBillingSubscriptions(),
      hasActiveVpsMigrationLock,
      tryClaimVpsMigration,
      releaseVpsMigrationLock,
      getBusiness,
      getSubscription,
      updateSubscription,
      getActiveVpsSshKey,
      // Cooldown reads this sweep's OWN purchases only. A term-renewal
      // purchase is not evidence that a contract upgrade failed.
      getLastContractUpgradePurchaseAt: (businessId: string) =>
        getLastEnqueuedAtForPurpose(businessId, "contract_upgrade"),
      hostinger,
      backupBusinessData,
      restoreBusinessData,
      orchestrateProvisioning,
      releaseVpsToPool,
      markVpsNeverRenew,
      sendOpsEmail: sendOpsHardwareMigrationEmail
    });

    logger.info("vps contract-upgrade sweep complete", {
      checked: result.checked,
      alreadyCovered: result.alreadyCovered,
      migrated: result.migrated,
      findings: result.findings.length
    });

    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("vps-contract-upgrade-sweep", runSweep);
