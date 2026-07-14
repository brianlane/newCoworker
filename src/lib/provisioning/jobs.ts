/**
 * Signup-provisioning job ledger + watchdog retry (provisioning_jobs).
 *
 * Why this exists: checkout-triggered provisioning runs inside the Stripe
 * webhook's Vercel function, and the runtime keeps that function alive
 * only up to its maxDuration — twice (Truly Insurance Jul 8 2026, KYP Ads
 * Jul 14 2026) a real signup's orchestrator was torn down mid-provision,
 * leaving the tenant stuck at "Provisioning started 5%" with no error, no
 * retry, and a human doing the recovery by hand.
 *
 * The shape of the fix:
 *   * the webhook ENQUEUES a job row, then still runs the orchestrator
 *     inline (fast path, now via `after()` + a raised maxDuration);
 *   * every recordProvisioningProgress write bumps the job's heartbeat;
 *   * a pg_cron watchdog (Edge `provisioning-watchdog` →
 *     /api/internal/provisioning-retry) claims ONE stalled job per tick —
 *     queued-but-never-started, or running with a stale heartbeat — and
 *     re-runs the orchestrator, which is idempotent end to end (pool
 *     claims, SSH keys, gateway tokens, deploy).
 *
 * Every write here is deliberately best-effort from the caller's point of
 * view: the ledger must never break a signup that would otherwise work.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ProvisioningJobStatus = "queued" | "running" | "succeeded" | "failed";

export type ProvisioningJobRow = {
  business_id: string;
  status: ProvisioningJobStatus;
  attempts: number;
  max_attempts: number;
  tier: string | null;
  vps_size: string | null;
  billing_period: string | null;
  last_error: string | null;
  enqueued_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

/**
 * Heartbeat staleness before the watchdog considers a job dead. Must
 * exceed the longest legitimately-silent orchestrator phase: a fresh
 * Hostinger purchase + PIS boot produces zero progress rows for ~5-8
 * minutes (Truly's successful run had a 5-minute silent gap).
 */
export const PROVISIONING_STALE_AFTER_MS = 10 * 60 * 1000;

export type EnqueueProvisioningJobInput = {
  businessId: string;
  tier: string | null;
  vpsSize: string | null;
  billingPeriod: string | null;
};

/**
 * Upsert the business's job row back to a fresh 'queued' state. Called
 * right before the inline runner dispatches, so even if the function dies
 * before the orchestrator writes anything, the watchdog has a row to find.
 * Re-checkout after a wipe reuses the same PK row (attempts reset).
 */
export async function enqueueProvisioningJob(
  input: EnqueueProvisioningJobInput,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("provisioning_jobs").upsert(
    {
      business_id: input.businessId,
      status: "queued",
      attempts: 0,
      tier: input.tier,
      vps_size: input.vpsSize,
      billing_period: input.billingPeriod,
      last_error: null,
      enqueued_at: new Date().toISOString(),
      started_at: null,
      heartbeat_at: null,
      completed_at: null,
      updated_at: new Date().toISOString()
    },
    { onConflict: "business_id" }
  );
  if (error) throw new Error(`enqueueProvisioningJob: ${error.message}`);
}

/** Inline-runner claim: queued → running (attempts+1). Best-effort. */
export async function markProvisioningJobRunning(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: row, error: readErr } = await db
    .from("provisioning_jobs")
    .select("attempts")
    .eq("business_id", businessId)
    .maybeSingle();
  if (readErr) throw new Error(`markProvisioningJobRunning: ${readErr.message}`);
  const attempts = Number((row as { attempts?: number } | null)?.attempts ?? 0);
  const { error } = await db
    .from("provisioning_jobs")
    .update({
      status: "running",
      attempts: attempts + 1,
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId);
  if (error) throw new Error(`markProvisioningJobRunning: ${error.message}`);
}

/** Terminal outcome for the business's job row. Best-effort at call sites. */
export async function markProvisioningJobOutcome(
  businessId: string,
  outcome: "succeeded" | "failed",
  lastError?: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("provisioning_jobs")
    .update({
      status: outcome,
      last_error: lastError ? lastError.slice(0, 1000) : null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId);
  if (error) throw new Error(`markProvisioningJobOutcome: ${error.message}`);
}

/**
 * Liveness bump, called from recordProvisioningProgress on every progress
 * write (orchestrator phases AND the in-deploy VPS callbacks). Never
 * throws — a heartbeat failure must not fail the progress write.
 *
 * Covers 'queued' rows as well as 'running' ones (Bugbot High on PR #598):
 * when the inline runner's best-effort markRunning write fails, the row
 * stays 'queued' while the orchestrator is very much alive — heartbeating
 * it anyway is what stops the watchdog's queued-never-started claim from
 * starting a SECOND provision in parallel (the claim treats a fresh
 * heartbeat as liveness regardless of status).
 */
export async function heartbeatProvisioningJob(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { error } = await db
      .from("provisioning_jobs")
      .update({ heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("business_id", businessId)
      .in("status", ["queued", "running"]);
    if (error) throw new Error(error.message);
  } catch (err) {
    logger.warn("heartbeatProvisioningJob failed (non-fatal)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/** Watchdog claim of one stalled job (see the SQL function for semantics). */
export async function claimStalledProvisioningJob(
  staleAfterMs: number = PROVISIONING_STALE_AFTER_MS,
  client?: SupabaseClient
): Promise<ProvisioningJobRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("claim_stalled_provisioning_job", {
    p_stale_ms: staleAfterMs
  });
  if (error) throw new Error(`claimStalledProvisioningJob: ${error.message}`);
  const rows = (data as ProvisioningJobRow[] | null) ?? [];
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Flip attempts-exhausted, heartbeat-stale jobs to 'failed' (Bugbot Medium
 * on PR #598: they otherwise sit 'running' forever once the watchdog stops
 * claiming them). Returns the settled business ids so the watchdog tick
 * can surface them in telemetry — an exhausted job is a tenant a human
 * must now look at.
 */
export async function settleExhaustedProvisioningJobs(
  staleAfterMs: number = PROVISIONING_STALE_AFTER_MS,
  client?: SupabaseClient
): Promise<string[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("settle_exhausted_provisioning_jobs", {
    p_stale_ms: staleAfterMs
  });
  if (error) throw new Error(`settleExhaustedProvisioningJobs: ${error.message}`);
  return ((data as ProvisioningJobRow[] | null) ?? []).map((row) => row.business_id);
}

// ---------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------

export type OrchestrateFn = (input: {
  businessId: string;
  tier: "starter" | "standard" | "enterprise";
  vpsSize: string | null;
  billingPeriod: "monthly" | "annual" | "biennial" | null;
}) => Promise<{ hostingerBillingSubscriptionId: string | null }>;

export type RunProvisioningJobDeps = {
  orchestrate: OrchestrateFn;
  markRunning?: typeof markProvisioningJobRunning;
  markOutcome?: typeof markProvisioningJobOutcome;
};

function narrowTier(raw: string | null): "starter" | "standard" | "enterprise" {
  return raw === "starter" || raw === "enterprise" ? raw : "standard";
}

function narrowBillingPeriod(raw: string | null): "monthly" | "annual" | "biennial" | null {
  return raw === "monthly" || raw === "annual" || raw === "biennial" ? raw : null;
}

/**
 * Run one provisioning job under the ledger: running → orchestrate →
 * succeeded/failed. Ledger writes are best-effort (a marker failure must
 * never abort a provision); the orchestrator's OWN error still propagates
 * to the caller after the failure is recorded, so existing logging keeps
 * working unchanged.
 */
export async function runProvisioningJob(
  job: Pick<ProvisioningJobRow, "business_id" | "tier" | "vps_size" | "billing_period">,
  deps: RunProvisioningJobDeps,
  opts: { alreadyClaimed?: boolean } = {}
): Promise<{ hostingerBillingSubscriptionId: string | null }> {
  /* c8 ignore next 2 -- trivial production-default fallbacks; tests inject */
  const markRunning = deps.markRunning ?? markProvisioningJobRunning;
  const markOutcome = deps.markOutcome ?? markProvisioningJobOutcome;

  if (!opts.alreadyClaimed) {
    await markRunning(job.business_id).catch((err: unknown) => {
      logger.warn("provisioning job markRunning failed (continuing)", {
        businessId: job.business_id,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }

  try {
    const result = await deps.orchestrate({
      businessId: job.business_id,
      tier: narrowTier(job.tier),
      vpsSize: job.vps_size,
      billingPeriod: narrowBillingPeriod(job.billing_period)
    });
    await markOutcome(job.business_id, "succeeded").catch((err: unknown) => {
      logger.warn("provisioning job markOutcome(succeeded) failed", {
        businessId: job.business_id,
        error: err instanceof Error ? err.message : String(err)
      });
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markOutcome(job.business_id, "failed", message).catch((markErr: unknown) => {
      logger.warn("provisioning job markOutcome(failed) failed", {
        businessId: job.business_id,
        error: markErr instanceof Error ? markErr.message : String(markErr)
      });
    });
    throw err;
  }
}

export type RetryStalledProvisioningDeps = {
  claim?: typeof claimStalledProvisioningJob;
  settleExhausted?: typeof settleExhaustedProvisioningJobs;
  getBusinessStatus: (businessId: string) => Promise<string | null>;
  orchestrate: OrchestrateFn;
  markOutcome?: typeof markProvisioningJobOutcome;
};

export type RetryStalledProvisioningResult = (
  | { kind: "idle" }
  | { kind: "already_online"; businessId: string }
  | { kind: "retried"; businessId: string; attempts: number }
  | { kind: "retry_failed"; businessId: string; attempts: number; error: string }
) & {
  /** Business ids whose exhausted jobs this tick flipped to 'failed'. */
  exhaustedFailed?: string[];
};

/**
 * One watchdog tick: claim one stalled job and re-run it.
 *
 * The already-online guard is load-bearing: the orchestrator has no
 * internal "tenant already serving" check (its callers guard), so a stale
 * job whose provision actually finished — or that an operator completed
 * by hand, exactly the KYP recovery — must resolve to 'succeeded' without
 * re-provisioning live hardware.
 */
export async function retryStalledProvisioningJob(
  deps: RetryStalledProvisioningDeps
): Promise<RetryStalledProvisioningResult> {
  /* c8 ignore next 3 -- trivial production-default fallbacks; tests inject */
  const claim = deps.claim ?? claimStalledProvisioningJob;
  const settleExhausted = deps.settleExhausted ?? settleExhaustedProvisioningJobs;
  const markOutcome = deps.markOutcome ?? markProvisioningJobOutcome;

  // Terminal-state hygiene first: attempts-exhausted zombies flip to
  // 'failed' so ops sees them (telemetry carries the ids) instead of a
  // forever-'running' row the claim below correctly ignores. Best-effort.
  let exhaustedFailed: string[] = [];
  try {
    exhaustedFailed = await settleExhausted();
  } catch (err) {
    logger.warn("provisioning watchdog: exhausted-job settle failed", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
  const withExhausted = <T extends RetryStalledProvisioningResult>(result: T): T =>
    exhaustedFailed.length > 0 ? { ...result, exhaustedFailed } : result;

  const job = await claim();
  if (!job) return withExhausted({ kind: "idle" });

  const status = await deps.getBusinessStatus(job.business_id);
  if (status === "online" || status === "high_load") {
    await markOutcome(job.business_id, "succeeded").catch((err: unknown) => {
      logger.warn("provisioning watchdog: online-job settle failed", {
        businessId: job.business_id,
        error: err instanceof Error ? err.message : String(err)
      });
    });
    return withExhausted({ kind: "already_online", businessId: job.business_id });
  }

  try {
    await runProvisioningJob(
      job,
      { orchestrate: deps.orchestrate, markOutcome },
      { alreadyClaimed: true }
    );
    return withExhausted({ kind: "retried", businessId: job.business_id, attempts: job.attempts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return withExhausted({
      kind: "retry_failed",
      businessId: job.business_id,
      attempts: job.attempts,
      error: message
    });
  }
}
