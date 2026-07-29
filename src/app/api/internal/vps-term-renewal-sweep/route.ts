/**
 * Internal, cron-triggered fleet term-renewal sweep.
 *
 * Call chain: pg_cron (daily) → Edge fn `vps-term-renewal-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Migrates at most one Stripe-backed tenant onto a fresh first-period-priced
 * Hostinger box when renewal is approaching and the live catalog undercuts
 * renewal by at least 10%. See src/lib/vps/term-renewal-sweep.ts.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse, handleRouteError } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { listBusinesses } from "@/lib/db/businesses";
import { listBusinessIdsWithLiveSubscription, listSubscriptionsByBusinessIds, getSubscription, updateSubscription } from "@/lib/db/subscriptions";
import {
  listVpsInventory,
  releaseVpsToPool,
  markVpsNeverRenew
} from "@/lib/db/vps-inventory";
import {
  hasActiveVpsMigrationLock,
  tryClaimVpsMigration,
  releaseVpsMigrationLock
} from "@/lib/db/vps-migration-locks";
import { getBusiness } from "@/lib/db/businesses";
import { getActiveVpsSshKey } from "@/lib/db/vps-ssh-keys";
import { backupBusinessData, restoreBusinessData } from "@/lib/hostinger/data-migration";
import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";
import { runTermRenewalSweep } from "@/lib/vps/term-renewal-sweep";
import { sendOpsHardwareMigrationEmail } from "@/lib/email/ops-notify";

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

    const result = await runTermRenewalSweep({
      listBusinesses,
      listBusinessIdsWithLiveSubscription,
      listSubscriptionsByBusinessIds,
      listInventory: listVpsInventory,
      listCatalog: () => hostinger.listCatalog("VPS"),
      listBillingSubscriptions: () => hostinger.listBillingSubscriptions(),
      hasActiveVpsMigrationLock,
      tryClaimVpsMigration,
      releaseVpsMigrationLock,
      getBusiness,
      getSubscription,
      updateSubscription,
      getActiveVpsSshKey,
      hostinger,
      backupBusinessData,
      restoreBusinessData,
      orchestrateProvisioning,
      releaseVpsToPool,
      markVpsNeverRenew,
      sendOpsEmail: sendOpsHardwareMigrationEmail
    });

    logger.info("vps term-renewal sweep complete", {
      checked: result.checked,
      skippedEconomics: result.skippedEconomics,
      migrated: result.migrated,
      findings: result.findings.length
    });

    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
