#!/usr/bin/env tsx
/**
 * One-shot: resume AiFlow runs that failed terminal on 2026-09-15 solely
 * because Telnyx rejected the SMS Idempotency-Key header (HTTP 400 / code
 * 10015, pointer /header/Idempotency-Key).
 *
 * INCIDENT. AiFlow send_sms / route_to_team built logical keys with colons
 * (`aiflow:${runId}:${step}`). Telnyx allows only [A-Za-z0-9_-]{1,255}, so
 * every such send 400'd and the worker dead-lettered the run at that SMS
 * step (permanent 4xx path, current_step left on the failed step). PR #1853
 * encodes the header at the shared SMS client. These runs still sit
 * `failed`; claim_ai_flow_runs only leases `queued` rows, so nothing retries
 * them until this script flips status back.
 *
 * WHAT THIS DOES. Opposite of `requeue-failed-flow-run.ts`, which inserts a
 * FRESH run at current_step 0 and would redo customer outreach. This keeps
 * the same row, keeps current_step, sets status=queued, and clears
 * last_error / error_retry_count / claimed_at / earliest_claim_at so the
 * worker claims the run and executeRun starts at the failed send_sms.
 *
 * ALLOWLIST ONLY. The eleven run ids Brian approved. Refuses HomeLight
 * Referral, Clever Spoke Check `6b6a0f11-6d68-43d0-afa4-2f06ffa4a1a0`, and
 * any route_to_team offer/broadcast (team-notify after park). A row that is
 * already queued/running/done/canceled is a no-op. A failed row whose step
 * moved, whose step is not send_sms, or that lacks 10015 / Idempotency-Key
 * evidence is refused.
 *
 * Idempotent, dry-run by default, ledger-recorded on a successful write.
 *
 * Usage:
 *   npx tsx scripts/oneshot/resume-telnyx-10015-runs.ts            # dry run
 *   npx tsx scripts/oneshot/resume-telnyx-10015-runs.ts --apply
 *   npx tsx scripts/oneshot/resume-telnyx-10015-runs.ts --run-id <uuid>
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Exit codes: 0 dry-run / applied / nothing-to-do, 1 Supabase error, 2 bad arg or env.
 */
import { pathToFileURL } from "node:url";

export type TargetRun = {
  id: string;
  expectedStep: number;
  label: string;
};

/**
 * Brian-approved failed send_sms runs from the 2026-09-15 10015 incident.
 * expectedStep is the live current_step at approve-time; apply refuses if it
 * moved, because that would retry the wrong step.
 */
export const TARGET_RUNS: readonly TargetRun[] = [
  { id: "2351afb8-9ce2-40d4-8291-8b53d8be07d7", expectedStep: 7, label: "KYP Lead follow-up" },
  { id: "c16e4acd-3e61-4a0b-ac3a-e4d247f0ef22", expectedStep: 7, label: "KYP Lead follow-up" },
  { id: "e7dd39cb-6a98-46c7-9043-25b72c9db5bd", expectedStep: 9, label: "KYP Lead follow-up" },
  { id: "ff8adf36-f3a7-4c21-a410-2cd277fe1741", expectedStep: 0, label: "Amy Clever Homeward Offers" },
  { id: "8ac9eddd-4fae-4001-8dc2-ef18423f31bf", expectedStep: 6, label: "KYP VFM Calendly booking follow-up" },
  { id: "93f69577-4dc3-4ad1-a0ce-1dd12834bb8f", expectedStep: 12, label: "Amy Needs Follow Up (AI cadence)" },
  { id: "49c5391f-dc5a-4896-b612-60f730a922d6", expectedStep: 6, label: "Amy ReferralExchange Lead" },
  { id: "178ea407-1568-4966-991d-9604c230340b", expectedStep: 17, label: "KIN Lead follow-up" },
  { id: "f453b064-fb59-4c23-9f75-341dfdc8d0d0", expectedStep: 9, label: "KYP Lead follow-up" },
  { id: "28fa9be6-b8b0-49ae-9e9a-ce4a4417cfab", expectedStep: 6, label: "Amy ReferralExchange Lead" },
  { id: "54c0cbc6-bbae-4fdc-bd4e-f4623aa233dd", expectedStep: 11, label: "KYP Lead follow-up" }
];

/** Clever Spoke Check: route_to_team after park. Brian said leave it. */
export const EXCLUDED_RUN_IDS: ReadonlySet<string> = new Set([
  "6b6a0f11-6d68-43d0-afa4-2f06ffa4a1a0"
]);

/**
 * The worker's claim_ai_flow_runs RPC only leases status=queued. executeRun
 * then starts at current_step. Do NOT send current_step in this patch: a
 * missing key leaves the failed SMS step in place. last_error / retry count
 * reset so a fresh attempt of THAT step is not immediately dead-lettered.
 */
export const RESUME_PATCH = {
  status: "queued" as const,
  last_error: null,
  error_retry_count: 0,
  claimed_at: null,
  earliest_claim_at: null
};

export type ClassifyInput = {
  id: string;
  status: string;
  currentStep: number;
  lastError: string | null;
  logEvidence?: string | null;
  flowName: string;
  stepType: string | null;
  broadcastAll?: boolean | null;
};

export type ClassifyResult = {
  action: "resume" | "skip" | "refuse";
  reason: string;
};

export type ParsedArgs =
  | { ok: true; apply: boolean; runIds: string[] }
  | { ok: false; error: string };

const TARGET_BY_ID = new Map(TARGET_RUNS.map((r) => [r.id, r]));

export function targetRunById(id: string): TargetRun | undefined {
  return TARGET_BY_ID.get(id);
}

export function parseResumeArgs(argv: readonly string[]): ParsedArgs {
  let apply = false;
  const runIds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") {
      apply = true;
      continue;
    }
    if (a === "--run-id") {
      const id = argv[++i];
      if (!id || id.startsWith("--")) {
        return { ok: false, error: "Required: --run-id <uuid>" };
      }
      if (!TARGET_BY_ID.has(id)) {
        return {
          ok: false,
          error: `--run-id ${id} is not on the approved 10015 resume allowlist`
        };
      }
      if (EXCLUDED_RUN_IDS.has(id)) {
        return { ok: false, error: `--run-id ${id} is excluded (Spoke Check / offer SMS)` };
      }
      runIds.push(id);
      continue;
    }
    return { ok: false, error: `Unknown argument: ${a}` };
  }
  return {
    ok: true,
    apply,
    runIds: runIds.length > 0 ? [...new Set(runIds)] : TARGET_RUNS.map((r) => r.id)
  };
}

/** Evidence the failure was Telnyx 10015 on the Idempotency-Key header. */
export function looksLikeTelnyx10015(text: string | null | undefined): boolean {
  if (!text) return false;
  const hay = text.toLowerCase();
  if (hay.includes("/header/idempotency-key")) return true;
  const namesHeader = hay.includes("idempotency-key") || hay.includes("idempotency key");
  if (!namesHeader) return false;
  return hay.includes("10015") || hay.includes("telnyx 400") || hay.includes("telnyx rejected");
}

export function isExcludedFlowName(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("homelight") || n.includes("spoke check");
}

export function isAllowedResumeStepType(
  stepType: string | null,
  broadcastAll?: boolean | null
): boolean {
  if (stepType !== "send_sms") return false;
  return broadcastAll !== true;
}

export function redactPhones(text: string): string {
  return text.replace(/\+\d{8,15}/g, "+[redacted]");
}

export function classifyRun(input: ClassifyInput, expected: TargetRun): ClassifyResult {
  if (input.id !== expected.id) {
    return { action: "refuse", reason: `id ${input.id} does not match expected ${expected.id}` };
  }
  if (EXCLUDED_RUN_IDS.has(input.id)) {
    return { action: "refuse", reason: "excluded run (Spoke Check / offer SMS after park)" };
  }
  if (isExcludedFlowName(input.flowName)) {
    return {
      action: "refuse",
      reason: `flow "${input.flowName}" is HomeLight or Spoke Check; leave it`
    };
  }
  if (input.status === "queued" || input.status === "running") {
    return { action: "skip", reason: `already ${input.status}; worker owns or will claim it` };
  }
  if (input.status === "done" || input.status === "canceled") {
    return { action: "skip", reason: `already ${input.status}; nothing to resume` };
  }
  if (input.status !== "failed") {
    return { action: "refuse", reason: `status is "${input.status}", not failed` };
  }
  if (input.currentStep !== expected.expectedStep) {
    return {
      action: "refuse",
      reason:
        `current_step is ${input.currentStep}, expected ${expected.expectedStep} ` +
        `(the failed SMS step). Refusing so we do not retry a different step.`
    };
  }
  if (!isAllowedResumeStepType(input.stepType, input.broadcastAll)) {
    return {
      action: "refuse",
      reason:
        `step type is ${input.stepType ?? "unknown"} (broadcastAll=${String(input.broadcastAll ?? false)}). ` +
        "Only send_sms is resumed; route_to_team offer/broadcast stays parked."
    };
  }
  const evidence = looksLikeTelnyx10015(input.lastError) || looksLikeTelnyx10015(input.logEvidence);
  if (!evidence) {
    return {
      action: "refuse",
      reason: "no Telnyx 10015 / Idempotency-Key evidence on last_error or system logs"
    };
  }
  return {
    action: "resume",
    reason: `requeue at current_step ${input.currentStep} (${input.stepType})`
  };
}

/* c8 ignore start -- the IO shell; the pure helpers above are tested */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { loadEnv } = await import("../../debug/_shared.ts");
  loadEnv();
  const { createClient } = await import("@supabase/supabase-js");
  const { recordOneshotApplied } = await import("./_ledger.ts");
  const { flattenSteps } = await import("../../supabase/functions/_shared/ai_flows/branching.ts");
  const { basename } = await import("node:path");

  const parsed = parseResumeArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(2);
  }
  const { apply, runIds } = parsed;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });
  const SCRIPT = basename(process.argv[1] ?? "resume-telnyx-10015-runs.ts");

  type RunRow = {
    id: string;
    business_id: string;
    flow_id: string;
    status: string;
    current_step: number;
    last_error: string | null;
    error_retry_count: number | null;
    claimed_at: string | null;
    revision: number;
    updated_at: string;
  };

  const { data: runs, error: readErr } = await db
    .from("ai_flow_runs")
    .select(
      "id, business_id, flow_id, status, current_step, last_error, error_retry_count, claimed_at, revision, updated_at"
    )
    .in("id", runIds);
  if (readErr) {
    console.error(`Read ai_flow_runs failed: ${readErr.message}`);
    process.exit(1);
  }

  const byId = new Map(((runs ?? []) as RunRow[]).map((r) => [r.id, r]));
  const flowIds = [...new Set(((runs ?? []) as RunRow[]).map((r) => r.flow_id))];
  const { data: flows, error: flowErr } =
    flowIds.length > 0
      ? await db.from("ai_flows").select("id, name, definition").in("id", flowIds)
      : { data: [], error: null };
  if (flowErr) {
    console.error(`Read ai_flows failed: ${flowErr.message}`);
    process.exit(1);
  }
  const flowById = new Map(
    (
      (flows ?? []) as Array<{
        id: string;
        name: string;
        definition: { steps?: unknown[] } | null;
      }>
    ).map((f) => [f.id, f])
  );

  async function logEvidenceFor(run: RunRow): Promise<string | null> {
    if (looksLikeTelnyx10015(run.last_error)) return null;
    const { data: logs, error } = await db
      .from("system_logs")
      .select("message")
      .eq("business_id", run.business_id)
      .eq("payload->>run_id", run.id)
      .in("event", ["ai_flow_run_failed", "ai_flow_step_failed"])
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) {
      console.error(`  system_logs read failed for ${run.id}: ${error.message}`);
      return null;
    }
    const hit = (logs ?? []).find((l) => looksLikeTelnyx10015(l.message));
    return hit?.message ?? null;
  }

  console.log(apply ? "MODE: APPLY (writing)" : "MODE: DRY RUN (no writes)");
  console.log(
    `claim_ai_flow_runs leases queued runs from current_step; this script ` +
      `does not reset current_step and does not insert a new run.\n`
  );

  const summary: Array<{
    run_id: string;
    business_id?: string;
    flow?: string;
    action: string;
    reason: string;
    current_step?: number;
    before_status?: string;
    after_status?: string;
  }> = [];
  let resumed = 0;
  let skipped = 0;
  let refused = 0;

  for (const id of runIds) {
    const expected = targetRunById(id);
    if (!expected) {
      console.log(`REFUSE ${id}: not on allowlist`);
      refused += 1;
      summary.push({ run_id: id, action: "refuse", reason: "not on allowlist" });
      continue;
    }
    const run = byId.get(id);
    if (!run) {
      console.log(`SKIP  ${id} (${expected.label}): not found`);
      skipped += 1;
      summary.push({ run_id: id, action: "skip", reason: "run not found" });
      continue;
    }
    const flow = flowById.get(run.flow_id);
    const flat = flattenSteps(
      (Array.isArray(flow?.definition?.steps) ? flow?.definition?.steps : []) as never
    );
    const step = flat[run.current_step];
    const evidence = await logEvidenceFor(run);
    const decision = classifyRun(
      {
        id: run.id,
        status: run.status,
        currentStep: run.current_step,
        lastError: run.last_error,
        logEvidence: evidence,
        flowName: flow?.name ?? "",
        stepType: step?.step?.type ?? null,
        broadcastAll: (step?.step as { broadcastAll?: boolean } | undefined)?.broadcastAll ?? null
      },
      expected
    );
    const line =
      `${decision.action.toUpperCase().padEnd(6)} ${run.id}  ${expected.label}  ` +
      `status=${run.status} step=${run.current_step} type=${step?.step?.type ?? "?"}  ` +
      decision.reason;
    console.log(line);
    if (run.last_error) {
      console.log(`       last_error: ${redactPhones(run.last_error).slice(0, 220)}`);
    }

    if (decision.action === "skip") {
      skipped += 1;
      summary.push({
        run_id: run.id,
        business_id: run.business_id,
        flow: flow?.name,
        action: "skip",
        reason: decision.reason,
        current_step: run.current_step,
        before_status: run.status
      });
      continue;
    }
    if (decision.action === "refuse") {
      refused += 1;
      summary.push({
        run_id: run.id,
        business_id: run.business_id,
        flow: flow?.name,
        action: "refuse",
        reason: decision.reason,
        current_step: run.current_step,
        before_status: run.status
      });
      continue;
    }

    if (!apply) {
      resumed += 1;
      summary.push({
        run_id: run.id,
        business_id: run.business_id,
        flow: flow?.name,
        action: "resume",
        reason: decision.reason,
        current_step: run.current_step,
        before_status: run.status,
        after_status: "queued"
      });
      continue;
    }

    const { data: updated, error: updateErr } = await db
      .from("ai_flow_runs")
      .update({
        ...RESUME_PATCH,
        updated_at: new Date().toISOString()
      })
      .eq("id", run.id)
      .eq("status", "failed")
      .eq("revision", run.revision)
      .eq("current_step", expected.expectedStep)
      .select("id, status, current_step, last_error, error_retry_count");
    if (updateErr) {
      console.error(`       update failed: ${updateErr.message}`);
      refused += 1;
      summary.push({
        run_id: run.id,
        business_id: run.business_id,
        flow: flow?.name,
        action: "refuse",
        reason: `update failed: ${updateErr.message}`,
        current_step: run.current_step,
        before_status: run.status
      });
      continue;
    }
    const after = (updated ?? [])[0] as
      | {
          status: string;
          current_step: number;
          last_error: string | null;
          error_retry_count: number;
        }
      | undefined;
    if (!after) {
      console.error("       update matched no rows (run changed underneath us); left alone");
      skipped += 1;
      summary.push({
        run_id: run.id,
        business_id: run.business_id,
        flow: flow?.name,
        action: "skip",
        reason: "CAS miss: status/revision/current_step changed underneath us",
        current_step: run.current_step,
        before_status: run.status
      });
      continue;
    }
    if (after.current_step !== expected.expectedStep) {
      console.error(
        `       current_step moved to ${after.current_step}; expected ${expected.expectedStep}`
      );
    }
    console.log(
      `       -> status=${after.status} current_step=${after.current_step} ` +
        `last_error=${after.last_error ?? "null"} error_retry_count=${after.error_retry_count}`
    );
    resumed += 1;
    summary.push({
      run_id: run.id,
      business_id: run.business_id,
      flow: flow?.name,
      action: "resume",
      reason: decision.reason,
      current_step: after.current_step,
      before_status: run.status,
      after_status: after.status
    });
  }

  console.log(
    `\n${apply ? "Applied" : "Would resume"} ${resumed}, skipped ${skipped}, refused ${refused}.`
  );
  if (!apply) {
    console.log("Re-run with --apply to land it. The worker claims queued runs on the next tick.");
  } else if (resumed > 0) {
    const businessIds = [...new Set(summary.filter((s) => s.action === "resume").map((s) => s.business_id).filter(Boolean))];
    for (const businessId of businessIds) {
      await recordOneshotApplied(db, {
        scriptPath: SCRIPT,
        businessId: businessId ?? null,
        details: {
          resumed,
          skipped,
          refused,
          runs: summary.filter((s) => s.business_id === businessId)
        }
      });
    }
  }
}

/* c8 ignore stop */
