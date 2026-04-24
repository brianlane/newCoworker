/**
 * Internal, cron-triggered endpoint that wipes canceled subscriptions whose
 * 30-day data-retention grace window has expired.
 *
 * Call chain: pg_cron → edge fn `subscription-grace-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Per-row behavior (idempotent — safe to re-run if any prior step failed
 * mid-way):
 *   1. Load `LifecycleContext` for the business (falls back to `listUsers`
 *      to resolve `ownerAuthUserId` from owner_email).
 *   2. `planLifecycleAction({ type: "graceExpiredWipe" })` — yields a plan
 *      with Hostinger snapshot-delete, Storage backup-delete, subscription
 *      `wiped_at` stamp, business `status='wiped'`, and optional
 *      `auth.admin.deleteUser`.
 *   3. `executeLifecyclePlan(...)` — runs the plan. Missing VM/snapshot is
 *      treated as benign (prior runs likely already tore them down).
 *
 * Response: `{ ok: true, processed, wiped, skipped, errors: [...] }`.
 * Errors on individual rows are captured and the sweep continues on the
 * next row — one broken tenant can't block the rest.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { listGraceExpiredSubscriptions } from "@/lib/db/subscriptions";
import { getBusiness } from "@/lib/db/businesses";
import { findAuthUserIdByEmail } from "@/lib/auth";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import { planLifecycleAction } from "@/lib/billing/lifecycle";
import { executeLifecyclePlan } from "@/lib/billing/lifecycle-executor";

const DEFAULT_BATCH_LIMIT = 50;

export const runtime = "nodejs";

type SweepError = {
  businessId: string;
  subscriptionId: string;
  message: string;
};

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  const now = new Date();

  let expired;
  try {
    expired = await listGraceExpiredSubscriptions(now, DEFAULT_BATCH_LIMIT);
  } catch (err) {
    logger.error("subscription-grace-sweep: listGraceExpiredSubscriptions failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Failed to list grace-expired subscriptions", 500);
  }

  const processed = expired.length;
  let wiped = 0;
  let skipped = 0;
  const errors: SweepError[] = [];

  for (const sub of expired) {
    try {
      const business = await getBusiness(sub.business_id);
      if (!business) {
        skipped += 1;
        logger.warn("subscription-grace-sweep: business missing; skipping", {
          subscriptionId: sub.id,
          businessId: sub.business_id
        });
        continue;
      }

      // Resolve the owner's Supabase auth user id from their email. Falls
      // back to null — the planner's `graceExpiredWipe` only emits the
      // delete_auth_user op when we actually have an id, so a missing
      // lookup just means we skip that single op on this row.
      const ownerAuthUserId = business.owner_email
        ? await findAuthUserIdByEmail(business.owner_email)
        : null;

      const ctxRes = await loadLifecycleContextForBusiness(business.id, {
        ownerAuthUserId: ownerAuthUserId ?? undefined
      });
      if (!ctxRes.ok) {
        skipped += 1;
        logger.warn("subscription-grace-sweep: context load failed; skipping", {
          subscriptionId: sub.id,
          businessId: business.id,
          reason: ctxRes.reason
        });
        continue;
      }

      const planRes = planLifecycleAction({ type: "graceExpiredWipe" }, ctxRes.context);
      if (!planRes.ok) {
        skipped += 1;
        logger.info("subscription-grace-sweep: planner rejected; skipping", {
          subscriptionId: sub.id,
          businessId: business.id,
          reason: planRes.reason
        });
        continue;
      }

      await executeLifecyclePlan(planRes.plan, {
        businessId: business.id,
        vpsHost: ctxRes.vpsHost,
        customerProfileId: ctxRes.context.subscription.customer_profile_id
      });

      wiped += 1;
      logger.info("subscription-grace-sweep: wiped", {
        subscriptionId: sub.id,
        businessId: business.id,
        graceEndsAt: sub.grace_ends_at
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ businessId: sub.business_id, subscriptionId: sub.id, message });
      logger.error("subscription-grace-sweep: wipe failed; continuing", {
        subscriptionId: sub.id,
        businessId: sub.business_id,
        error: message
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.info("subscription-grace-sweep: summary", {
    processed,
    wiped,
    skipped,
    errors: errors.length,
    durationMs
  });

  return successResponse({
    processed,
    wiped,
    skipped,
    errors,
    durationMs
  });
}
