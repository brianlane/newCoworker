/**
 * flow-run-autopsy.ts: explain ONE AiFlow run, where it stopped, and what
 * never got to run because of it.
 *
 * `debug/flow-poll.ts` answers "what did the engine just do". This answers the
 * harder follow-up after a failure: a run's `current_step` is a flat integer
 * over a NESTED definition, so "failed at step 21" tells you nothing on its
 * own, and the steps that never executed leave no rows at all. Reconstructing
 * that by hand (dump the definition, flatten it the way the worker does, map
 * the index back to a step id, diff against the executed rows) is the exact
 * work this replaces.
 *
 * The steps that never ran are usually the real cost of a failure. The run
 * that prompted this tool (Amy Laidlaw, HomeLight Referral, Jul 2026) died at
 * step 21 of 60 on an empty templated email recipient, which silently threw
 * away the two late-contact retry rungs and the owner wrap-up sitting behind
 * it. The failure message named the email; only the skipped tail named the
 * damage.
 *
 * Indices come from the engine's own `flattenSteps`, not a local re-walk, so
 * they always agree with `ai_flow_runs.current_step`.
 *
 *   tsx debug/flow-run-autopsy.ts <runId>
 *   tsx debug/flow-run-autopsy.ts <runId> --vars       # include context vars
 *   tsx debug/flow-run-autopsy.ts <runId> --full       # do not truncate values
 *   tsx debug/flow-run-autopsy.ts <runId> --json       # machine-readable
 *
 * Read-only. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env`.
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";
import { flattenSteps, type FlatStepEntry } from "../supabase/functions/_shared/ai_flows/branching.ts";

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env)");
  process.exit(1);
}

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const runId = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
const showVars = flag("vars");
const full = flag("full");
const asJson = flag("json");

if (!runId) {
  console.error("usage: tsx debug/flow-run-autopsy.ts <runId> [--vars] [--full] [--json]");
  process.exit(1);
}

/**
 * Vars that carry lead PII. Truncated by default so an autopsy can be pasted
 * into a PR or a ticket; `--full` prints them verbatim.
 */
const PII_VAR_RE = /(^|_)(phone|email|address|name)$/i;

/** Engine bookkeeping vars, folded into a count unless --vars is passed. */
const ENGINE_VAR_RE = /^__/;

function short(value: unknown, max = 80): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return "undefined";
  if (s === "") return '""';
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * The extraction sentinels. Never masked: "this var says none" is usually the
 * whole diagnosis (it is what an empty `{{vars.lead_email}}` looks like one
 * step before it takes a run down), and none of them is anyone's data.
 */
const SENTINEL_VALUES = new Set(["", "none", "n/a", "na", "null", "unknown", "no_call", "no_reply"]);

function varDisplay(key: string, value: unknown): string {
  if (full) return short(value, 2000);
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (PII_VAR_RE.test(key) && !SENTINEL_VALUES.has(s.trim().toLowerCase())) {
    return `${s.slice(0, 3)}... (${s.length} chars, --full to show)`;
  }
  return short(value);
}

type RunRow = {
  id: string;
  flow_id: string;
  business_id: string;
  status: string;
  current_step: number | null;
  attempt_count: number | null;
  error_retry_count: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  context: { vars?: Record<string, unknown> } | null;
};

type StepRow = {
  step_index: number;
  step_type: string;
  status: string;
  error: string | null;
  updated_at: string;
};

type LogRow = {
  level: string;
  event: string;
  message: string | null;
  created_at: string;
};

/** A one-line summary of a step's `when` guard, for the tree view. */
function whenSummary(step: Record<string, unknown>): string {
  const w = step.when as Record<string, unknown> | undefined;
  if (!w || typeof w !== "object" || typeof w.var !== "string") return "";
  for (const op of ["equals", "notEquals", "contains"]) {
    if (typeof w[op] === "string") return ` when ${w.var} ${op} "${w[op] as string}"`;
  }
  return ` when ${w.var}`;
}

async function main(): Promise<void> {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: runData, error: runErr } = await sb
    .from("ai_flow_runs")
    .select(
      "id,flow_id,business_id,status,current_step,attempt_count,error_retry_count,last_error,created_at,updated_at,context"
    )
    .eq("id", runId)
    .maybeSingle();
  if (runErr) {
    console.error(`run lookup failed: ${runErr.message}`);
    process.exit(1);
  }
  if (!runData) {
    console.error(`no ai_flow_runs row with id ${runId}`);
    process.exit(1);
  }
  const run = runData as RunRow;

  const [{ data: flowData }, { data: bizData }, { data: stepData }, { data: logData }] =
    await Promise.all([
      sb.from("ai_flows").select("name,definition").eq("id", run.flow_id).maybeSingle(),
      sb.from("businesses").select("name").eq("id", run.business_id).maybeSingle(),
      sb
        .from("ai_flow_run_steps")
        .select("step_index,step_type,status,error,updated_at")
        .eq("run_id", run.id)
        .order("step_index"),
      sb
        .from("system_logs")
        .select("level,event,message,created_at")
        .eq("business_id", run.business_id)
        .contains("payload", { run_id: run.id })
        .order("created_at")
    ]);

  const flowName = (flowData as { name?: string } | null)?.name ?? "(flow row missing)";
  const bizName = (bizData as { name?: string } | null)?.name ?? run.business_id;
  const definition = (flowData as { definition?: { steps?: unknown } } | null)?.definition;
  const flat: FlatStepEntry[] = flattenSteps(
    (Array.isArray(definition?.steps) ? definition.steps : []) as Parameters<
      typeof flattenSteps
    >[0]
  );

  const executed = new Map<number, StepRow>();
  for (const row of (stepData ?? []) as StepRow[]) executed.set(row.step_index, row);

  const vars = run.context?.vars ?? {};
  const resumeStepId = typeof vars.__resume_step_id === "string" ? vars.__resume_step_id : null;

  // Where it stopped. current_step is authoritative; __resume_step_id is the
  // engine's own id-based marker, and a disagreement is worth seeing (it means
  // the definition was edited while the run was parked).
  const stoppedAt = run.current_step ?? -1;
  const stoppedEntry = flat[stoppedAt];
  const stoppedById = resumeStepId
    ? flat.findIndex((e) => (e.step as { id: string }).id === resumeStepId)
    : -1;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          run,
          flow: { id: run.flow_id, name: flowName },
          business: { id: run.business_id, name: bizName },
          total_steps: flat.length,
          stopped_at: stoppedAt,
          stopped_step_id: stoppedEntry ? (stoppedEntry.step as { id: string }).id : null,
          resume_step_id: resumeStepId,
          executed: [...executed.values()],
          never_ran: flat
            .map((e, i) => ({ i, id: (e.step as { id: string }).id }))
            .filter(({ i }) => i > stoppedAt),
          logs: logData ?? []
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`run      ${run.id}`);
  console.log(`business ${bizName} (${run.business_id})`);
  console.log(`flow     ${flowName} (${run.flow_id})`);
  console.log(
    `status   ${run.status}  |  current_step ${stoppedAt} of ${flat.length}  |  attempts ${run.attempt_count ?? 0}, error retries ${run.error_retry_count ?? 0}`
  );
  console.log(`started  ${run.created_at}`);
  console.log(`ended    ${run.updated_at}`);
  if (run.last_error) console.log(`error    ${run.last_error.split("\n")[0]}`);
  if (stoppedEntry) {
    console.log(`stopped  [${stoppedAt}] ${(stoppedEntry.step as { id: string }).id} (${(stoppedEntry.step as { type: string }).type})`);
  }
  if (resumeStepId && stoppedById !== -1 && stoppedById !== stoppedAt) {
    console.log(
      `  NOTE: __resume_step_id "${resumeStepId}" is flat index ${stoppedById}, not ${stoppedAt}. The definition changed while this run was parked.`
    );
  }

  console.log("\nsteps (* = where it stopped)");
  for (let i = 0; i < flat.length; i++) {
    const entry = flat[i];
    const step = entry.step as unknown as Record<string, unknown>;
    const row = executed.get(i);
    const depth = entry.branchPath.length;
    const arm = depth > 0 ? entry.branchPath[depth - 1] : null;
    const armLabel = arm ? `${arm.branchStepId}/${arm.armId}: ` : "";
    const state = row
      ? row.status
      : i > stoppedAt
        ? "NEVER RAN"
        : i === stoppedAt
          ? "stopped here"
          : "no row";
    const marker = i === stoppedAt ? "*" : " ";
    console.log(
      `${marker} [${String(i).padStart(2)}] ${"  ".repeat(depth)}${armLabel}${step.id as string} (${step.type as string})${whenSummary(step)}  ->  ${state}${row?.error ? `: ${short(row.error.split("\n")[0], 70)}` : ""}`
    );
  }

  const neverRan = flat.slice(stoppedAt + 1);
  if (neverRan.length > 0) {
    console.log(
      `\n${neverRan.length} step(s) never ran because the run ended at ${stoppedAt}. This is the cost of the failure:`
    );
    for (const entry of neverRan) {
      const step = entry.step as unknown as Record<string, unknown>;
      console.log(`  - ${step.id as string} (${step.type as string})`);
    }
  }

  if (showVars) {
    console.log("\ncontext vars");
    const keys = Object.keys(vars).sort();
    const engine = keys.filter((k) => ENGINE_VAR_RE.test(k));
    for (const k of keys.filter((k) => !ENGINE_VAR_RE.test(k))) {
      console.log(`  ${k} = ${varDisplay(k, vars[k])}`);
    }
    if (engine.length > 0) {
      console.log(`  (+ ${engine.length} engine vars: ${engine.join(", ")})`);
    }
  } else {
    console.log(`\n${Object.keys(vars).length} context var(s). Pass --vars to print them.`);
  }

  const logs = (logData ?? []) as LogRow[];
  if (logs.length > 0) {
    console.log("\nsystem_logs for this run");
    for (const l of logs) {
      console.log(
        `  ${l.created_at} ${l.level.toUpperCase().padEnd(5)} ${l.event}  ${short(l.message ?? "", 90).split("\n")[0]}`
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
