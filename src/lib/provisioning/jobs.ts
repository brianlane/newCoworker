/**
 * Provisioning job ledger + watchdog retry (provisioning_jobs).
 *
 * Why this exists: checkout-triggered provisioning runs inside the Stripe
 * webhook's Vercel function, and the runtime keeps that function alive
 * only up to its maxDuration, twice (Truly Insurance Jul 8 2026, KYP Ads
 * Jul 14 2026) a real signup's orchestrator was torn down mid-provision,
 * leaving the tenant stuck at "Provisioning started 5%" with no error, no
 * retry, and a human doing the recovery by hand. The same kill also hit
 * term-renewal mid-deploy (KYP Ads Jul 29 2026): background migrations now
 * enqueue here too so the watchdog can finish them.
 *
 * The shape of the fix:
 *   * callers ENQUEUE a job row, then still run the orchestrator inline;
 *   * every recordProvisioningProgress write bumps the job's heartbeat;
 *   * a pg_cron watchdog (Edge `provisioning-watchdog` →
 *     /api/internal/provisioning-retry) claims ONE stalled job per tick,
 *     queued-but-never-started, or running with a stale heartbeat, and
 *     re-runs the orchestrator, which is idempotent end to end (pool
 *     claims, SSH keys, gateway tokens, deploy).
 *
 * Every write here is deliberately best-effort from the caller's point of
 * view: the ledger must never break a signup that would otherwise work.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import type { LatestProvisioningStatus } from "@/lib/provisioning/progress";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ProvisioningJobStatus = "queued" | "running" | "succeeded" | "failed";

export type ProvisioningJobPurpose =
  | "signup"
  | "migrate_size"
  | "term_renewal"
  /**
   * Move a contract tenant off short-runway hardware onto a box whose
   * Hostinger term covers the rest of their contract. Distinct from
   * `term_renewal` (which replaces a box that is about to renew at full
   * price) because the two are triggered by different sweeps and the
   * purchase cooldown must not confuse one for the other.
   */
  | "contract_upgrade";

export type ProvisioningJobRow = {
  business_id: string;
  status: ProvisioningJobStatus;
  attempts: number;
  max_attempts: number;
  tier: string | null;
  vps_size: string | null;
  billing_period: string | null;
  /**
   * Explicit Hostinger purchase term for this job (`1m` / `1y` / `2y`).
   * Null falls back to deriving it from `billing_period`. Carried on the
   * ROW because the enqueue and the run are separate steps: a migration
   * that computed "buy 1y to cover the remaining contract" must not have
   * that decision silently re-derived as 2y when the watchdog re-runs it.
   */
  hostinger_term: string | null;
  suppress_owner_notify: boolean;
  skip_pool_adopt: boolean;
  purpose: ProvisioningJobPurpose;
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
  hostingerTerm?: string | null;
  suppressOwnerNotify?: boolean;
  skipPoolAdopt?: boolean;
  purpose?: ProvisioningJobPurpose;
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
      hostinger_term: input.hostingerTerm ?? null,
      suppress_owner_notify: input.suppressOwnerNotify === true,
      skip_pool_adopt: input.skipPoolAdopt === true,
      purpose: input.purpose ?? "signup",
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

/**
 * When a term-renewal job was last enqueued for this business, or null when
 * the current row is for some other purpose (or there is no row).
 *
 * `enqueued_at` is stamped BEFORE the Hostinger purchase call, so it survives
 * a migration that buys a box and then fails, which is exactly the state the
 * term-renewal sweep's purchase cooldown has to detect. Caveat that keeps this
 * a two-source check at the call site: `business_id` is the primary key and
 * enqueue upserts on conflict, so a later signup or migrate_size enqueue
 * overwrites the row. There is no history here.
 */
export async function getLastTermRenewalEnqueuedAt(
  businessId: string,
  client?: SupabaseClient
): Promise<Date | null> {
  return getLastEnqueuedAtForPurpose(businessId, "term_renewal", client);
}

/**
 * Same lookup, for any migration purpose.
 *
 * The two box-replacing sweeps must each cool down on THEIR OWN purchases
 * and not on each other's: a contract upgrade that bought a 2y box last
 * night is not evidence that the renewal sweep's purchase failed, and
 * treating it as such would park a tenant whose box is genuinely about to
 * lapse. Matching on `purpose` is what keeps the two independent.
 */
export async function getLastEnqueuedAtForPurpose(
  businessId: string,
  purpose: ProvisioningJobPurpose,
  client?: SupabaseClient
): Promise<Date | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("provisioning_jobs")
    .select("purpose, enqueued_at")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getLastEnqueuedAtForPurpose: ${error.message}`);
  const row = data as { purpose?: string | null; enqueued_at?: string | null } | null;
  if (!row || row.purpose !== purpose || !row.enqueued_at) return null;
  const at = new Date(row.enqueued_at);
  return Number.isNaN(at.getTime()) ? null : at;
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
 * throws, a heartbeat failure must not fail the progress write.
 *
 * Covers 'queued' rows as well as 'running' ones (Bugbot High on PR #598):
 * when the inline runner's best-effort markRunning write fails, the row
 * stays 'queued' while the orchestrator is very much alive, heartbeating
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
 * can surface them in telemetry, an exhausted job is a tenant a human
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
  hostingerTerm?: "1m" | "1y" | "2y" | null;
  suppressOwnerNotify?: boolean;
  skipPoolAdopt?: boolean;
}) => Promise<{
  hostingerBillingSubscriptionId: string | null;
  vpsId?: string;
  /**
   * False when the deploy did not finish cleanly. Optional so callers that do
   * not tear anything down can ignore it; migration cutovers must not.
   */
  deploySucceeded?: boolean;
}>;

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

function narrowPurpose(raw: string | null | undefined): ProvisioningJobPurpose {
  return raw === "migrate_size" || raw === "term_renewal" || raw === "contract_upgrade"
    ? raw
    : "signup";
}

/**
 * Narrow a stored term to the three Hostinger sells. Anything else (null, a
 * typo, a term Hostinger retired) reads as "no explicit term", which falls
 * back to the `billing_period` derivation rather than failing the job.
 */
function narrowHostingerTerm(raw: string | null | undefined): "1m" | "1y" | "2y" | null {
  return raw === "1m" || raw === "1y" || raw === "2y" ? raw : null;
}

/**
 * Run one provisioning job under the ledger: running → orchestrate →
 * succeeded/failed. Ledger writes are best-effort (a marker failure must
 * never abort a provision); the orchestrator's OWN error still propagates
 * to the caller after the failure is recorded, so existing logging keeps
 * working unchanged.
 */
export async function runProvisioningJob(
  job: Pick<ProvisioningJobRow, "business_id" | "tier" | "vps_size" | "billing_period"> &
    Partial<
      Pick<
        ProvisioningJobRow,
        "suppress_owner_notify" | "skip_pool_adopt" | "purpose" | "hostinger_term"
      >
    >,
  deps: RunProvisioningJobDeps,
  opts: { alreadyClaimed?: boolean } = {}
): Promise<{
  hostingerBillingSubscriptionId: string | null;
  vpsId?: string;
  deploySucceeded?: boolean;
}> {
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
      billingPeriod: narrowBillingPeriod(job.billing_period),
      hostingerTerm: narrowHostingerTerm(job.hostinger_term),
      suppressOwnerNotify: job.suppress_owner_notify === true ? true : undefined,
      skipPoolAdopt: job.skip_pool_adopt === true ? true : undefined
    });
    // Background migrations still owe restore/teardown after orchestrate
    // returns. Leave the job running until the sweep marks succeeded.
    const purpose = narrowPurpose(job.purpose);
    if (purpose === "signup") {
      await markOutcome(job.business_id, "succeeded").catch((err: unknown) => {
        logger.warn("provisioning job markOutcome(succeeded) failed", {
          businessId: job.business_id,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    } else {
      logger.info("provisioning job: migration deploy done; cutover still pending", {
        businessId: job.business_id,
        purpose
      });
    }
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
  /**
   * Latest provisioning progress. Used so migration retries do not buy a
   * second VPS when deploy already finished (or can be resumed in place).
   */
  getLatestProgress?: (businessId: string) => Promise<LatestProvisioningStatus>;
  /**
   * Resume an in-flight detached deploy on the CURRENT box (no acquireVps).
   * Required for safe mid-deploy migration retries while the tenant is online.
   */
  resumeMigrationDeploy?: (input: {
    businessId: string;
    purpose: ProvisioningJobPurpose;
  }) => Promise<{ hostingerBillingSubscriptionId: string | null; vpsId?: string }>;
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
 * The already-online guard is load-bearing for SIGNUP jobs: the orchestrator
 * has no internal "tenant already serving" check (its callers guard), so a
 * stale signup whose provision actually finished, or that an operator
 * completed by hand, must resolve to 'succeeded' without re-provisioning
 * live hardware.
 *
 * Background migrations (purpose migrate_size / term_renewal) take the
 * progress-based path instead, because re-running full orchestrate would buy
 * another VPS (the sweep enqueues them with skip_pool_adopt: true, so
 * acquireVps cannot even fall back to the pool):
 *   * settle when progress already shows deploy complete, or
 *   * resume the detached deploy on the current box when mid-deploy, or
 *   * fall through to full orchestrate only for early/pre-deploy failures.
 *
 * That branch is deliberately NOT gated on business status. An earlier version
 * required status 'online', on the assumption that migrations are "already
 * online by design". They are not: orchestrateProvisioning writes 'offline' at
 * 22%, before the deploy phase, and only restores 'online' after it, so for the
 * entire mid-deploy window (exactly what this recovery is for) the status reads
 * 'offline' and every migration fell through to a second purchase.
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

  const purpose = narrowPurpose(job.purpose);
  const status = await deps.getBusinessStatus(job.business_id);
  if (purpose === "signup" && (status === "online" || status === "high_load")) {
    await markOutcome(job.business_id, "succeeded").catch((err: unknown) => {
      logger.warn("provisioning watchdog: online-job settle failed", {
        businessId: job.business_id,
        error: err instanceof Error ? err.message : String(err)
      });
    });
    return withExhausted({ kind: "already_online", businessId: job.business_id });
  }

  if (purpose !== "signup") {
    let latest: LatestProvisioningStatus = null;
    if (deps.getLatestProgress) {
      try {
        latest = await deps.getLatestProgress(job.business_id);
      } catch (err) {
        logger.warn("provisioning watchdog: migration progress lookup failed", {
          businessId: job.business_id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    // Orchestrator phase "complete" means deploy finished, NOT that
    // migrate/term-renewal cutover (restore/teardown) finished. Treat it the
    // same as deploy_client_complete so the stuck alert keeps firing.
    if (
      latest?.phase === "complete" ||
      latest?.phase === "deploy_client_complete" ||
      (latest?.percent === 100 && latest.logStatus !== "error")
    ) {
      const message =
        "deploy finished but migration cutover still pending (restore/teardown)";
      await markOutcome(job.business_id, "failed", message).catch(() => undefined);
      return withExhausted({
        kind: "retry_failed",
        businessId: job.business_id,
        attempts: job.attempts,
        error: message
      });
    }

    const midDeploy =
      latest != null &&
      latest.logStatus !== "error" &&
      latest.percent >= 40 &&
      latest.percent < 100;
    if (midDeploy && deps.resumeMigrationDeploy) {
      try {
        await deps.resumeMigrationDeploy({
          businessId: job.business_id,
          purpose
        });
        // Deploy only: the dead sweep must still finish cutover. Fail the job
        // with a clear reason so the stuck alert keeps firing for ops.
        const message =
          "deploy resumed by watchdog; migration cutover still pending (restore/teardown)";
        await markOutcome(job.business_id, "failed", message).catch(() => undefined);
        return withExhausted({
          kind: "retry_failed",
          businessId: job.business_id,
          attempts: job.attempts,
          error: message
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await markOutcome(job.business_id, "failed", message).catch(() => undefined);
        return withExhausted({
          kind: "retry_failed",
          businessId: job.business_id,
          attempts: job.attempts,
          error: message
        });
      }
    }
  }

  try {
    await runProvisioningJob(
      {
        ...job,
        suppress_owner_notify: job.suppress_owner_notify === true,
        skip_pool_adopt: job.skip_pool_adopt === true,
        purpose
      },
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
