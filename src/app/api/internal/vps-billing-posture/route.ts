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
import { logger } from "@/lib/logger";
import { listBusinesses } from "@/lib/db/businesses";
import { listSubscriptionsByBusinessIds } from "@/lib/db/subscriptions";
import { listVpsInventory } from "@/lib/db/vps-inventory";
import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";
import { checkVpsBillingPosture } from "@/lib/vps/billing-posture";
import { sendOpsBillingPostureEmail } from "@/lib/email/ops-notify";

// Fleet-sized budget: one VM detail call per live tenant plus two list
// calls. Even at 10× today's fleet this finishes in seconds; 60s covers
// Hostinger's slow days (their API has been observed taking 30-60s per
// call under load — the very incident class this cron guards).
export const maxDuration = 60;
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

    const result = await checkVpsBillingPosture({
      listBusinesses,
      listSubscriptionsByBusinessIds,
      listInventory: listVpsInventory,
      getVirtualMachine: (vmId) => hostinger.getVirtualMachine(vmId),
      listBillingSubscriptions: () => hostinger.listBillingSubscriptions(),
      enableAutoRenewal: (subscriptionId) => hostinger.enableBillingAutoRenewal(subscriptionId)
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
      autoHealed: result.findings.filter((f) => f.autoHealed).length
    });

    return successResponse({
      checkedTenantVms: result.checkedTenantVms,
      checkedPoolBoxes: result.checkedPoolBoxes,
      findings: result.findings
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
