/**
 * Internal, cron-triggered provisioning watchdog.
 *
 * Call chain: pg_cron (every 5 min) → Edge fn `provisioning-watchdog` →
 * this route. Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Claims ONE stalled provisioning job (queued-never-started or running
 * with a heartbeat older than ~10 minutes — see
 * src/lib/provisioning/jobs.ts) and re-runs the orchestrator, which is
 * idempotent end to end. Exists because the Stripe-webhook function that
 * runs signup provisioning inline can be torn down by the runtime
 * mid-provision (Truly Insurance Jul 8 2026, KYP Ads Jul 14 2026 — both
 * stuck at "started 5%" until a human re-ran them by hand).
 *
 * One job per tick keeps a tick's work bounded; multiple stalled jobs
 * drain across consecutive 5-minute ticks.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse, handleRouteError } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { retryStalledProvisioningJob } from "@/lib/provisioning/jobs";
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";
import { getBusiness } from "@/lib/db/businesses";
import { getSubscription, updateSubscription } from "@/lib/db/subscriptions";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

// Vercel Pro ceiling: a full adopt/purchase provision runs ~8-12 minutes.
// The Edge bridge / pg_cron may stop awaiting sooner — harmless, the
// function runs to completion (same acceptance as vps-billing-posture).
export const maxDuration = 800;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const result = await retryStalledProvisioningJob({
      getBusinessStatus: async (businessId) => (await getBusiness(businessId))?.status ?? null,
      orchestrate: async (input) => {
        const out = await orchestrateProvisioning({
          businessId: input.businessId,
          tier: input.tier,
          vpsSize: input.vpsSize,
          billingPeriod: input.billingPeriod
        });
        // Same post-success persistence the webhook's inline runner does —
        // without it a watchdog-recovered signup would be missing the
        // Hostinger billing linkage the cancel lifecycle needs.
        if (out.hostingerBillingSubscriptionId) {
          try {
            const sub = await getSubscription(input.businessId);
            if (sub) {
              await updateSubscription(sub.id, {
                hostinger_billing_subscription_id: out.hostingerBillingSubscriptionId
              });
            }
          } catch (err) {
            logger.warn("watchdog: hostinger_billing_subscription_id persist failed", {
              businessId: input.businessId,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
        return out;
      }
    });

    if (result.kind !== "idle") {
      logger.info("provisioning watchdog tick", result);
      // Telemetry so ops dashboards/alerts can watch recovery activity —
      // a retry firing at all means an inline provision died.
      try {
        const db = await createSupabaseServiceClient();
        await db.rpc("telemetry_record", {
          p_event_type: "provisioning_watchdog_retry",
          p_payload: result
        });
      } catch (err) {
        logger.warn("provisioning watchdog telemetry emit failed", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
