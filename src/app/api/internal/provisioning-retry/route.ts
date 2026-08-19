/**
 * Internal, cron-triggered provisioning watchdog.
 *
 * Call chain: pg_cron (every 5 min) → Edge fn `provisioning-watchdog` →
 * this route. Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Claims ONE stalled provisioning job (queued-never-started or running
 * with a heartbeat older than ~10 minutes, see
 * src/lib/provisioning/jobs.ts) and re-runs the orchestrator, which is
 * idempotent end to end. Exists because the Stripe-webhook function that
 * runs signup provisioning inline can be torn down by the runtime
 * mid-provision (Truly Insurance Jul 8 2026, KYP Ads Jul 14 2026, both
 * stuck at "started 5%" until a human re-ran them by hand).
 *
 * One job per tick keeps a tick's work bounded; multiple stalled jobs
 * drain across consecutive 5-minute ticks.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse, handleRouteError } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { retryStalledProvisioningJob } from "@/lib/provisioning/jobs";
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";
import {
  alertFromWatchdogResult,
  scanAndAlertStuckProvisioning
} from "@/lib/provisioning/stuck-alert";
import { resumeMigrationDeploy } from "@/lib/provisioning/resume-migration-deploy";
import { getLatestProvisioningStatus } from "@/lib/provisioning/progress";
import { getBusiness } from "@/lib/db/businesses";
import { getSubscription, updateSubscription } from "@/lib/db/subscriptions";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

// Vercel Pro ceiling: a full adopt/purchase provision runs ~8-12 minutes.
// The Edge bridge / pg_cron may stop awaiting sooner, harmless, the
// function runs to completion (same acceptance as vps-billing-posture).
export const maxDuration = 1800;
export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const result = await retryStalledProvisioningJob({
      getBusinessStatus: async (businessId) => (await getBusiness(businessId))?.status ?? null,
      getLatestProgress: getLatestProvisioningStatus,
      resumeMigrationDeploy: async ({ businessId }) => resumeMigrationDeploy({ businessId }),
      orchestrate: async (input) => {
        const out = await orchestrateProvisioning({
          businessId: input.businessId,
          tier: input.tier,
          vpsSize: input.vpsSize,
          billingPeriod: input.billingPeriod,
          // The term the sweep COMPUTED and stored on the job row. Must be
          // forwarded: the purchase default is monthly now, so a stalled
          // term_renewal or contract_upgrade job that falls through to a full
          // re-provision would otherwise buy a monthly box and quietly defeat
          // the sweep that enqueued it. This object is rebuilt field by field
          // rather than spread, so anything not listed here is dropped.
          hostingerTerm: input.hostingerTerm,
          suppressOwnerNotify: input.suppressOwnerNotify,
          skipPoolAdopt: input.skipPoolAdopt,
          notifyOpsNewSignup: input.suppressOwnerNotify !== true
        });
        // Same post-success persistence the webhook's inline runner does,
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

    if (result.kind !== "idle" || result.exhaustedFailed) {
      logger.info("provisioning watchdog tick", result);
      // Telemetry so ops dashboards/alerts can watch recovery activity,
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

    try {
      await alertFromWatchdogResult(result);
    } catch (err) {
      logger.warn("provisioning stuck alert (watchdog result) failed", {
        error: err instanceof Error ? err.message : String(err)
      });
    }

    let stuckScan: { alerted: string[] } = { alerted: [] };
    try {
      stuckScan = await scanAndAlertStuckProvisioning({
        listCandidates: listStuckScanCandidatesFromDb
      });
      if (stuckScan.alerted.length > 0) {
        logger.info("provisioning stuck progress scan alerted", stuckScan);
      }
    } catch (err) {
      logger.warn("provisioning stuck progress scan failed", {
        error: err instanceof Error ? err.message : String(err)
      });
    }

    return successResponse({ ...result, stuckScan });
  } catch (err) {
    return handleRouteError(err);
  }
}

async function listStuckScanCandidatesFromDb(): Promise<
  import("@/lib/provisioning/stuck-alert").StuckScanCandidate[]
> {
  const db = await createSupabaseServiceClient();
  const { data: logs, error } = await db
    .from("coworker_logs")
    .select("business_id, created_at, status, log_payload")
    .eq("task_type", "provisioning")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw new Error(`stuck scan logs: ${error.message}`);
  if (!logs?.length) return [];

  const latestByBiz = new Map<string, (typeof logs)[number]>();
  for (const row of logs) {
    const id = row.business_id as string;
    if (!latestByBiz.has(id)) latestByBiz.set(id, row);
  }

  const businessIds = [...latestByBiz.keys()];
  const { data: businesses } = await db
    .from("businesses")
    .select("id, status")
    .in("id", businessIds);
  const statusById = new Map(
    (businesses ?? []).map((b) => [b.id as string, (b.status as string) ?? null])
  );

  const { data: jobs } = await db
    .from("provisioning_jobs")
    .select("business_id, status, purpose")
    .in("business_id", businessIds);
  const jobById = new Map(
    (jobs ?? []).map((j) => [
      j.business_id as string,
      {
        status: (j.status as string) ?? null,
        purpose: (j.purpose as string) ?? "signup"
      }
    ])
  );

  const out: import("@/lib/provisioning/stuck-alert").StuckScanCandidate[] = [];
  for (const [businessId, row] of latestByBiz) {
    const payload = (row.log_payload ?? {}) as {
      phase?: unknown;
      percent?: unknown;
    };
    if (payload.phase === "ops_provisioning_stuck_alert_sent") continue;
    out.push({
      businessId,
      phase: typeof payload.phase === "string" ? payload.phase : "",
      percent: typeof payload.percent === "number" ? payload.percent : 0,
      updatedAt: row.created_at as string,
      logStatus: (row.status as string) ?? null,
      businessStatus: statusById.get(businessId) ?? null,
      purpose: jobById.get(businessId)?.purpose ?? "signup",
      jobStatus: jobById.get(businessId)?.status ?? null
    });
  }
  return out;
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("provisioning-retry", runSweep);
