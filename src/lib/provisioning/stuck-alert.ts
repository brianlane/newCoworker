/**
 * Ops alert for stuck provisioning (KYP-class mid-deploy freeze).
 *
 * Fired from the 5-minute provisioning-retry tick when a job is exhausted /
 * retry_failed, or when a non-terminal progress row is older than 20 minutes
 * in the remote-deploy band (percent [40,99)).
 */

import { getBusiness } from "@/lib/db/businesses";
import { sendOpsProvisioningStuckEmail } from "@/lib/email/ops-notify";
import { logger } from "@/lib/logger";
import {
  getLatestProvisioningStatus,
  hasPriorOpsProvisioningStuckAlert,
  recordProvisioningProgress
} from "@/lib/provisioning/progress";
import type { RetryStalledProvisioningResult } from "@/lib/provisioning/jobs";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const STUCK_PROGRESS_AGE_MS = 20 * 60 * 1000;

/** Phases that count as mid-remote-deploy for the stuck scan. */
const STUCK_PHASE_HINTS = new Set([
  "remote_deploy_starting",
  "deploy_exception",
  "deploy_failed"
]);

export function isStuckProgressBand(input: {
  phase: string;
  percent: number;
  logStatus: string | null;
}): boolean {
  if (input.logStatus === "success" || input.logStatus === "error") return false;
  if (input.percent < 40 || input.percent >= 100) return false;
  if (STUCK_PHASE_HINTS.has(input.phase)) return true;
  // Mid-band without a known phase still counts (deploy script progress).
  return input.percent >= 40 && input.percent < 100;
}

export type StuckAlertDeps = {
  sendEmail?: typeof sendOpsProvisioningStuckEmail;
  hasPriorAlert?: typeof hasPriorOpsProvisioningStuckAlert;
  recordProgress?: typeof recordProvisioningProgress;
  getBusinessName?: (businessId: string) => Promise<string>;
  getLatestStatus?: typeof getLatestProvisioningStatus;
  now?: () => number;
};

async function defaultBusinessName(businessId: string): Promise<string> {
  /* c8 ignore start -- production getBusiness fallback; tests inject getBusinessName */
  try {
    const biz = await getBusiness(businessId);
    return biz?.name?.trim() || businessId;
  } catch {
    return businessId;
  }
  /* c8 ignore stop */
}

/**
 * Send at most one stuck alert per business (dedupe phase row).
 * Returns true when an email was sent.
 */
export async function maybeSendProvisioningStuckAlert(
  input: {
    businessId: string;
    phase: string;
    percent: number;
    ageMinutes: number;
    purpose: string;
    trigger: string;
  },
  deps: StuckAlertDeps = {}
): Promise<boolean> {
  const sendEmail = deps.sendEmail ?? sendOpsProvisioningStuckEmail;
  const hasPrior = deps.hasPriorAlert ?? hasPriorOpsProvisioningStuckAlert;
  const recordProgress = deps.recordProgress ?? recordProvisioningProgress;
  const getName = deps.getBusinessName ?? defaultBusinessName;

  try {
    if (await hasPrior(input.businessId)) return false;
  } catch (err) {
    logger.warn("stuck-alert: prior-alert lookup failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    // Fail open: still try to email once rather than silently skip forever.
  }

  const businessName = await getName(input.businessId);
  const sent = await sendEmail({
    businessId: input.businessId,
    businessName,
    phase: input.phase,
    percent: input.percent,
    ageMinutes: input.ageMinutes,
    purpose: input.purpose,
    trigger: input.trigger
  });
  if (!sent) return false;

  try {
    await recordProgress({
      businessId: input.businessId,
      phase: "ops_provisioning_stuck_alert_sent",
      percent: input.percent,
      message: `Ops stuck alert sent (${input.trigger})`,
      source: "orchestrator",
      status: "thinking"
    });
  } catch (err) {
    logger.warn("stuck-alert: dedupe progress write failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return true;
}

/**
 * After a watchdog tick: alert on exhausted / retry_failed outcomes.
 */
export async function alertFromWatchdogResult(
  result: RetryStalledProvisioningResult,
  deps: StuckAlertDeps = {}
): Promise<void> {
  const getLatest = deps.getLatestStatus ?? getLatestProvisioningStatus;
  const now = deps.now ?? Date.now;

  const targets: Array<{ businessId: string; trigger: string }> = [];
  for (const id of result.exhaustedFailed ?? []) {
    targets.push({ businessId: id, trigger: "exhausted_failed" });
  }
  if (result.kind === "retry_failed") {
    targets.push({ businessId: result.businessId, trigger: "retry_failed" });
  }

  for (const t of targets) {
    let phase = "unknown";
    let percent = 0;
    let ageMinutes = 0;
    try {
      const latest = await getLatest(t.businessId);
      if (latest) {
        phase = latest.phase || phase;
        percent = latest.percent;
        const ageMs = Math.max(0, now() - Date.parse(latest.updatedAt));
        ageMinutes = Math.round(ageMs / 60_000);
      }
    } catch {
      // Best-effort context for the email body.
    }
    await maybeSendProvisioningStuckAlert(
      {
        businessId: t.businessId,
        phase,
        percent,
        ageMinutes,
        purpose: "unknown",
        trigger: t.trigger
      },
      deps
    );
  }
}

export type StuckScanCandidate = {
  businessId: string;
  phase: string;
  percent: number;
  updatedAt: string;
  logStatus: string | null;
  businessStatus: string | null;
  purpose: string;
  jobStatus: string | null;
};

/**
 * Pure filter used by the scan + unit tests.
 */
export function selectStuckScanCandidates(
  rows: StuckScanCandidate[],
  nowMs: number,
  ageMs = STUCK_PROGRESS_AGE_MS
): StuckScanCandidate[] {
  return rows.filter((row) => {
    if (!isStuckProgressBand(row)) return false;
    const age = nowMs - Date.parse(row.updatedAt);
    if (!(age > ageMs)) return false;
    // KYP-shaped hole: business already online with percent < 100, or a
    // failed/exhausted job still showing mid-deploy progress.
    const jobBad =
      row.jobStatus === "failed" ||
      row.jobStatus === "running" ||
      row.jobStatus === "queued";
    const onlineHole =
      (row.businessStatus === "online" || row.businessStatus === "high_load") &&
      row.percent < 100;
    return jobBad || onlineHole;
  });
}

/**
 * Scan recent non-terminal provisioning progress and alert once per business.
 */
export async function scanAndAlertStuckProvisioning(
  deps: StuckAlertDeps & {
    listCandidates?: () => Promise<StuckScanCandidate[]>;
  } = {}
): Promise<{ alerted: string[] }> {
  const now = deps.now ?? Date.now;
  const list = deps.listCandidates ?? listStuckScanCandidatesFromDb;
  const candidates = selectStuckScanCandidates(await list(), now());
  const alerted: string[] = [];
  for (const row of candidates) {
    const ageMinutes = Math.round(
      Math.max(0, now() - Date.parse(row.updatedAt)) / 60_000
    );
    const sent = await maybeSendProvisioningStuckAlert(
      {
        businessId: row.businessId,
        phase: row.phase,
        percent: row.percent,
        ageMinutes,
        purpose: row.purpose,
        trigger: "stuck_progress_scan"
      },
      deps
    );
    if (sent) alerted.push(row.businessId);
  }
  return { alerted };
}

async function listStuckScanCandidatesFromDb(): Promise<StuckScanCandidate[]> {
  /* c8 ignore start -- PostgREST wiring; unit tests inject listCandidates */
  const db = await createSupabaseServiceClient();
  // Recent provisioning rows (newest first). Cap keeps the tick cheap.
  const { data: logs, error } = await db
    .from("coworker_logs")
    .select("business_id, created_at, status, log_payload")
    .eq("task_type", "provisioning")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw new Error(`stuck scan logs: ${error.message}`);
  if (!logs?.length) return [];

  // Dedupe to latest row per business.
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

  const out: StuckScanCandidate[] = [];
  for (const [businessId, row] of latestByBiz) {
    const payload = (row.log_payload ?? {}) as {
      phase?: unknown;
      percent?: unknown;
    };
    // Skip the dedupe marker itself as "latest".
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
  /* c8 ignore stop */
}
