/**
 * Internal, cron-triggered fleet billing-posture check.
 *
 * Call chain: pg_cron (daily) → Edge fn `vps-billing-posture` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Verifies every live tenant's Hostinger VM is set to auto-renew (healing
 * violations in place) and reports idle pooled boxes that are still paying.
 * See src/lib/vps/billing-posture.ts for the rules and the Jul 8 2026
 * incident that motivated this. Findings (including auto-healed ones) go to
 * the ops inbox.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse, handleRouteError } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { listBusinesses } from "@/lib/db/businesses";
import { listBusinessIdsWithLiveSubscription } from "@/lib/db/subscriptions";
import { listVpsInventory, refreshVpsInventoryExpiresAt, retireVps } from "@/lib/db/vps-inventory";
import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";
import { checkVpsBillingPosture } from "@/lib/vps/billing-posture";
import { sendOpsBillingPostureEmail } from "@/lib/email/ops-notify";

// Vercel Pro ceiling (mirrors delete-client / migrate-size). The check does
// one VM detail call per live tenant SEQUENTIALLY, and the HostingerClient's
// per-request timeout is 30s, on Hostinger's slow days (30-60s responses
// have been observed under load, the very incident class this cron guards)
// a 60s budget could abort mid-fleet before later tenants were checked or
// the findings email was sent. 300s covers ~10 worst-case tenants; the
// Edge bridge/pg_cron may stop awaiting the response sooner, which is
// harmless, the function runs to completion and the email sends anyway.
export const maxDuration = 300;
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

    // Keep vps_inventory.expires_at fresh so adopt-first ranks by furthest
    // paid-through date. Best-effort: a refresh failure must not skip the
    // posture heal/report that this cron exists for.
    const [inventoryForExpiry, billingSubs] = await Promise.all([
      listVpsInventory(),
      hostinger.listBillingSubscriptions()
    ]);
    let expiresRefreshed = 0;
    try {
      expiresRefreshed = await refreshVpsInventoryExpiresAt(inventoryForExpiry, billingSubs);
    } catch (err) {
      logger.warn("vps inventory expires_at refresh failed (continuing posture check)", {
        error: err instanceof Error ? err.message : String(err)
      });
    }

    const result = await checkVpsBillingPosture({
      listBusinesses,
      listBusinessIdsWithLiveSubscription,
      listInventory: listVpsInventory,
      getVirtualMachine: (vmId) => hostinger.getVirtualMachine(vmId),
      listVirtualMachines: () => hostinger.listVirtualMachines(),
      listBillingSubscriptions: async () => billingSubs,
      enableAutoRenewal: (subscriptionId) => hostinger.enableBillingAutoRenewal(subscriptionId),
      retireVps: (vmId, reason) => retireVps(vmId, reason)
    });

    if (result.findings.length > 0) {
      await sendOpsBillingPostureEmail({
        findings: result.findings,
        checkedTenantVms: result.checkedTenantVms,
        checkedPoolBoxes: result.checkedPoolBoxes
      });
    }

    logger.info("vps billing posture check complete", {
      checkedTenantVms: result.checkedTenantVms,
      checkedPoolBoxes: result.checkedPoolBoxes,
      findings: result.findings.length,
      autoHealed: result.findings.filter((f) => f.autoHealed).length,
      expiresRefreshed
    });

    return successResponse({
      checkedTenantVms: result.checkedTenantVms,
      checkedPoolBoxes: result.checkedPoolBoxes,
      findings: result.findings,
      expiresRefreshed
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("vps-billing-posture", runSweep);
