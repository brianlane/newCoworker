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

export const STUCK_PROGRESS_AGE_MS = 20 * 60 * 1000;

/**
 * Phases that count as mid-remote-deploy for the stuck scan.
 *
 * deploy_failed / deploy_exception are deliberately NOT here: those rows
 * are written with status "error", and the band check below returns false
 * for every error row, so listing them promised a coverage this scan never
 * had. A failed deploy alerts ops directly from the orchestrator's notify
 * branch (sendOpsDeployFailedEmail) instead.
 */
const STUCK_PHASE_HINTS = new Set(["remote_deploy_starting"]);

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

/* c8 ignore start -- production getBusiness fallback; tests inject getBusinessName */
async function defaultBusinessName(businessId: string): Promise<string> {
  try {
    const biz = await getBusiness(businessId);
    return biz?.name?.trim() || businessId;
  } catch {
    return businessId;
  }
}
/* c8 ignore stop */

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
  /* c8 ignore start -- production defaults; tests inject */
  const sendEmail = deps.sendEmail ?? sendOpsProvisioningStuckEmail;
  const hasPrior = deps.hasPriorAlert ?? hasPriorOpsProvisioningStuckAlert;
  const recordProgress = deps.recordProgress ?? recordProvisioningProgress;
  const getName = deps.getBusinessName ?? defaultBusinessName;
  /* c8 ignore stop */

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
  /* c8 ignore next 2 -- production defaults; tests inject */
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
        /* c8 ignore next -- empty phase falls back to "unknown" */
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
 * Callers must supply `listCandidates` (the Next route wires the DB query).
 */
export async function scanAndAlertStuckProvisioning(
  deps: StuckAlertDeps & {
    listCandidates: () => Promise<StuckScanCandidate[]>;
  }
): Promise<{ alerted: string[] }> {
  /* c8 ignore next -- production default; tests inject now */
  const now = deps.now ?? Date.now;
  const candidates = selectStuckScanCandidates(await deps.listCandidates(), now());
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
