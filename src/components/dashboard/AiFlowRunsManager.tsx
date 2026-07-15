"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  formatRunValue,
  retrySummary,
  routingSummary,
  runTriggerEntries,
  runVarEntries,
  type RunDataEntry
} from "@/lib/ai-flows/run-stats";
import { STEP_TYPE_LABELS } from "@/components/dashboard/aiflow-labels";
import type { AiFlowRunRow, AiFlowRunStepRow, ApprovalDecision } from "@/lib/ai-flows/db";
import {
  APPROVAL_OPTION_DECISIONS,
  APPROVAL_OPTION_INSTRUCTIONS,
  APPROVAL_OPTION_LABELS,
  parseStoredApprovalOptions,
  type ApprovalGateOption
} from "../../../supabase/functions/_shared/ai_flows/approval_options";

const OPTION_BUTTON_STYLES: Record<ApprovalGateOption, string> = {
  approve: "bg-claw-green/20 text-claw-green hover:bg-claw-green/30",
  skip: "bg-parchment/10 text-parchment/70 hover:bg-parchment/20",
  bypass_quiet_hours: "bg-signal-teal/15 text-signal-teal hover:bg-signal-teal/25",
  cancel: "bg-red-500/15 text-red-400 hover:bg-red-500/25"
};

const OPTION_BUTTON_TITLES: Record<ApprovalGateOption, string> = {
  approve: "Run the step this gate guards",
  skip: "Don't run this step, but continue the rest of the workflow",
  bypass_quiet_hours:
    "Approve, and send remaining texts immediately instead of waiting out quiet hours",
  cancel: "Stop the whole workflow"
};

const STATUS_STYLES: Record<string, string> = {
  queued: "bg-parchment/10 text-parchment/60",
  running: "bg-signal-teal/15 text-signal-teal",
  awaiting_approval: "bg-spark-orange/15 text-spark-orange",
  awaiting_agent: "bg-spark-orange/15 text-spark-orange",
  awaiting_reply: "bg-spark-orange/15 text-spark-orange",
  awaiting_call: "bg-spark-orange/15 text-spark-orange",
  done: "bg-claw-green/15 text-claw-green",
  failed: "bg-red-500/15 text-red-400",
  canceled: "bg-parchment/10 text-parchment/40"
};

// Display label overrides for statuses whose stored value differs from how we
// want to talk about it in the UI. The DB status stays `awaiting_agent`; the
// owner-facing badge reads "AWAITING EMPLOYEE".
const STATUS_LABELS: Record<string, string> = {
  awaiting_agent: "Awaiting employee",
  awaiting_reply: "Awaiting their reply",
  awaiting_call: "AI call in progress",
  canceled: "Stopped"
};

function statusLabel(status: string): string {
  return (STATUS_LABELS[status] ?? status.replace(/_/g, " ")).toUpperCase();
}

// Terminal statuses never update again, so their `updated_at` is a faithful
// "completed at" timestamp. Non-terminal runs (queued/running/awaiting_*) have
// no completion yet, so we only show "triggered at" for them.
const TERMINAL_STATUSES = new Set(["done", "failed", "canceled"]);

// Mirrors CANCELABLE_RUN_STATUSES in src/lib/ai-flows/db.ts (a value import
// would pull the server-only Supabase client into this client bundle). A
// `running` run cancels cooperatively: the worker quits at the next step
// boundary, so the step already in flight still completes.
const STOPPABLE_STATUSES = new Set([
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_agent",
  "awaiting_reply",
  "awaiting_call"
]);

export type AiFlowRef = { id: string; name: string };

/** A labeled, clickable screenshot thumbnail shown in the run "investigate" view. */
/** Friendly step name; legacy/unknown step types fall back to the raw value. */
function stepLabel(type: string): string {
  return (STEP_TYPE_LABELS as Record<string, string>)[type] ?? type;
}

/** True for a step skipped because it sat on an untaken branch path. */
function stepNotTaken(s: AiFlowRunStepRow): boolean {
  return s.status === "skipped" && s.result?.skipped === "branch_not_taken";
}

/**
 * The chosen-path label a branch step recorded (its set_vars result carries
 * `__branch_label_<id>`), e.g. "Auto" or "none matched".
 */
function branchChoiceLabel(s: AiFlowRunStepRow): string | null {
  if (s.step_type !== "branch") return null;
  const vars = (s.result?.vars ?? null) as Record<string, unknown> | null;
  if (!vars) return null;
  for (const [k, v] of Object.entries(vars)) {
    if (k.startsWith("__branch_label_") && typeof v === "string") return v;
  }
  return null;
}

/**
 * The vars a step's recorded result produced (its set_vars payload), minus
 * engine-internal underscore markers — "what did this step actually find".
 */
function stepProducedEntries(s: AiFlowRunStepRow): RunDataEntry[] {
  const vars = (s.result?.vars ?? null) as Record<string, unknown> | null;
  if (!vars || typeof vars !== "object") return [];
  return Object.entries(vars)
    .filter(([k]) => !k.startsWith("_"))
    .map(([key, value]) => ({ key, value: formatRunValue(value) }));
}

/** One key/value list of run data ("(empty)" keeps blank values visible). */
function DataList({ title, entries }: { title: string; entries: RunDataEntry[] }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-parchment/40">
        {title}
      </div>
      <dl className="space-y-0.5">
        {entries.map((e) => (
          <div key={e.key} className="flex gap-2 text-xs">
            <dt className="shrink-0 font-mono text-signal-teal/80">{e.key}</dt>
            <dd className="max-h-40 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words text-parchment/70">
              {e.value === "" ? (
                <span className="italic text-spark-orange/80">(empty)</span>
              ) : (
                e.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * "What data was in this run": the trigger content it started from and every
 * variable its steps produced so far. Shown for in-progress, completed, AND
 * failed runs — on a failure this is usually the answer ("lead_phone was
 * empty"), so it renders above the step list.
 */
function RunDataSection({ context }: { context: Record<string, unknown> }) {
  const trigger = runTriggerEntries(context);
  const vars = runVarEntries(context);
  if (trigger.length === 0 && vars.length === 0) return null;
  return (
    <div className="space-y-2 rounded-md border border-parchment/10 bg-deep-ink/30 p-2">
      {trigger.length > 0 && <DataList title="Trigger data" entries={trigger} />}
      {vars.length > 0 && <DataList title="Data captured (variables)" entries={vars} />}
    </div>
  );
}

function Screenshot({
  url,
  label,
  stepIndex,
  failed,
  sourceUrl
}: {
  url: string;
  label: string;
  stepIndex: number;
  failed: boolean;
  /** Signed URL to the captured page source (HTML) for this screenshot, if stored. */
  sourceUrl?: string | null;
}) {
  return (
    <div className="space-y-1">
      <span
        className={`block text-[10px] font-semibold uppercase tracking-wider ${
          failed ? "text-red-400/80" : "text-parchment/40"
        }`}
      >
        {label}
      </span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="Open full-size screenshot in a new tab"
        className="block"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={`${label}, step ${stepIndex + 1}`}
          className={`max-h-64 w-auto rounded-md border object-contain object-top transition hover:opacity-90 ${
            failed ? "border-red-500/40" : "border-parchment/15"
          }`}
        />
      </a>
      {sourceUrl && (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the captured page source (raw HTML) in a new tab"
          className="block text-[10px] font-medium text-sky-400/80 underline underline-offset-2 hover:text-sky-300"
        >
          View page source
        </a>
      )}
    </div>
  );
}

export function AiFlowRunsManager({
  businessId,
  initialRuns,
  flows,
  flowId,
  employeeNames = {}
}: {
  businessId: string;
  initialRuns: AiFlowRunRow[];
  flows: AiFlowRef[];
  /** When set, the page is scoped to one flow — keep the filter on reload. */
  flowId?: string;
  /** E.164 → roster/contact name for the employees offered a lead (routing). */
  employeeNames?: Record<string, string>;
}) {
  const [runs, setRuns] = useState<AiFlowRunRow[]>(initialRuns);
  const [flowList, setFlowList] = useState<AiFlowRef[]>(flows);
  // Kept in state (not just the prop) so a reload() can MERGE in names for
  // newly offered employees that weren't in the initial server snapshot —
  // otherwise an escalated offer would show a raw E.164 until a full reload.
  const [names, setNames] = useState<Record<string, string>>(employeeNames);
  // Set of expanded run ids. Multiple runs can be open at once (per-group
  // "Expand details"); default empty = every run's detail collapsed.
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  // Set of expanded flow-group ids. The group header toggles whether that
  // flow's RUN LIST is shown; default empty = every group collapsed, so the
  // page opens as a compact list of flows with their run counts.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [steps, setSteps] = useState<Record<string, AiFlowRunStepRow[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    // Refresh runs AND flows together: grouping/labels join runs to flow names,
    // so refreshing only runs could file a newly created flow's runs under
    // "Deleted flow" (the server-rendered flows snapshot wouldn't know it yet).
    const runsUrl =
      `/api/aiflows/runs?businessId=${encodeURIComponent(businessId)}` +
      (flowId ? `&flowId=${encodeURIComponent(flowId)}` : "");
    const [runsRes, flowsRes] = await Promise.all([
      fetch(runsUrl, { cache: "no-store" }),
      fetch(`/api/aiflows?businessId=${encodeURIComponent(businessId)}`, { cache: "no-store" })
    ]);
    const runsJson = (await runsRes.json()) as {
      ok: boolean;
      data?: { runs: AiFlowRunRow[]; employeeNames?: Record<string, string> };
    };
    if (runsJson.ok && runsJson.data) {
      setRuns(runsJson.data.runs);
      if (runsJson.data.employeeNames) {
        // Merge (don't replace): a name resolved on the first paint stays even
        // if a later reload's snapshot no longer includes that number.
        setNames((prev) => ({ ...prev, ...runsJson.data!.employeeNames }));
      }
    }
    const flowsJson = (await flowsRes.json()) as { ok: boolean; data?: AiFlowRef[] };
    if (flowsJson.ok && flowsJson.data) {
      setFlowList(flowsJson.data.map((f) => ({ id: f.id, name: f.name })));
    }
  };

  const loadSteps = async (runId: string) => {
    if (steps[runId]) return;
    const res = await fetch(
      `/api/aiflows/runs/${runId}?businessId=${encodeURIComponent(businessId)}`,
      { cache: "no-store" }
    );
    const json = (await res.json()) as { ok: boolean; data?: { steps: AiFlowRunStepRow[] } };
    if (json.ok && json.data) setSteps((s) => ({ ...s, [runId]: json.data!.steps }));
  };

  /** Owner "Stop this run": nothing further sends; no resume path revives it. */
  const stopRun = async (runId: string) => {
    setBusy(runId);
    setError(null);
    try {
      const res = await fetch(`/api/aiflows/runs/${runId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Could not stop the run");
      }
      // Reload on failure too (like `decide`): a CONFLICT usually means the
      // run moved (worker claimed it / finished / already stopped) and the
      // stale parked row with its Stop button must resync to reality.
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (runId: string) => {
    // Decide expand-vs-collapse from the CURRENT committed state, not from a
    // flag mutated inside the setState updater. React runs functional updaters
    // lazily during render, so a `willExpand` set inside the updater is still
    // false when the line after setExpandedRuns runs — which meant loadSteps
    // never fired on an individual run click and the row showed "No steps
    // recorded" until the group-level "Expand details" (which loads directly)
    // was used. `toggle` is recreated each render, so `expandedRuns` here is
    // the latest committed state and is accurate at click time.
    const willExpand = !expandedRuns.has(runId);
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
    if (willExpand) await loadSteps(runId);
  };

  // Expand/collapse every run in one flow group. Expanding loads each run's
  // steps (loadSteps no-ops on already-loaded runs).
  const setGroupExpanded = async (runIds: string[], expand: boolean) => {
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      for (const id of runIds) {
        if (expand) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    if (expand) await Promise.all(runIds.map((id) => loadSteps(id)));
  };

  // Show/hide a whole flow's run list (the primary expand/collapse). Cheap —
  // the runs are already loaded; only their per-run step details are fetched
  // lazily when an individual run (or "Expand details") opens.
  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  // Deep link from the dashboard "Recent activity" feed: ?run=<id> opens that
  // run's steps/error and scrolls it into view, so a failed run lands the owner
  // on the failure detail rather than the top of the list. Runs once per id.
  const deepLinkedRun = useSearchParams().get("run");
  const handledDeepLink = useRef<string | null>(null);
  const scrolledDeepLink = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinkedRun || handledDeepLink.current === deepLinkedRun) return;
    const run = runs.find((r) => r.id === deepLinkedRun);
    if (!run) return;
    handledDeepLink.current = deepLinkedRun;
    // Open the containing flow group (so the run renders) AND the run's detail.
    setExpandedGroups((prev) => new Set(prev).add(run.flow_id));
    setExpandedRuns((prev) => new Set(prev).add(deepLinkedRun));
    void loadSteps(deepLinkedRun);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkedRun, runs]);

  // Scroll only AFTER the row is expanded and its steps have mounted, so the
  // detail (error + steps + screenshots) is on the page when we center it —
  // scrolling right after expanding would center the still-collapsed row.
  useEffect(() => {
    if (!deepLinkedRun || scrolledDeepLink.current === deepLinkedRun) return;
    if (!expandedRuns.has(deepLinkedRun) || steps[deepLinkedRun] === undefined) return;
    scrolledDeepLink.current = deepLinkedRun;
    document
      .getElementById(`run-${deepLinkedRun}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [deepLinkedRun, expandedRuns, steps]);

  const decide = async (runId: string, decision: ApprovalDecision) => {
    setBusy(runId);
    setError(null);
    try {
      const res = await fetch(`/api/aiflows/runs/${runId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, decision })
      });
      if (!res.ok) {
        // A 409 (already decided) or other failure must NOT imply success.
        // The API shape is { ok:false, error:{ code, message } } — read the
        // message string, never the object (which renders as [object Object]).
        const detail = await res
          .json()
          .then((j: { error?: { message?: string } }) => j.error?.message)
          .catch(() => null);
        setError(detail || `Could not ${decision} this run (${res.status}). It may have already been decided.`);
      }
      // Always refresh so the list reflects the true server state.
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const pending = runs.filter((r) => r.status === "awaiting_approval");
  const routing = runs.filter((r) => r.status === "awaiting_agent");

  const flowName = (flowId: string) =>
    flowList.find((f) => f.id === flowId)?.name ?? "Deleted flow";

  // Group run history per AiFlow, then order groups by their most-recent run
  // (newest-run flow first) so the runs view matches the AiFlows page's
  // sort-by-last-run. Runs within a group stay newest-first as the API returns
  // them, so runs[0] is the group's latest run. Runs whose flow no longer
  // appears in the list (deleted between fetches — FK cascade removes them on
  // the next load) still group together as "Deleted flow".
  const grouped: Array<{ id: string; name: string; runs: AiFlowRunRow[] }> = [];
  const byFlow = new Map<string, AiFlowRunRow[]>();
  for (const r of runs) {
    const list = byFlow.get(r.flow_id);
    if (list) list.push(r);
    else byFlow.set(r.flow_id, [r]);
  }
  for (const [id, list] of byFlow) {
    grouped.push({ id, name: flowName(id), runs: list });
  }
  grouped.sort((a, b) => {
    const at = a.runs[0]?.created_at ?? "";
    const bt = b.runs[0]?.created_at ?? "";
    return at < bt ? 1 : at > bt ? -1 : 0;
  });

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}
      {pending.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-spark-orange">
            Approvals needed ({pending.length})
          </h2>
          {pending.map((r) => {
            const approval = (r.context.approval ?? {}) as {
              prompt?: string;
              options?: unknown;
            };
            // Render exactly the options the worker offered for THIS gate
            // (stored on the run when it parked) so dashboard buttons and the
            // SMS digit hint always agree. Cancel is always last.
            const options = parseStoredApprovalOptions(approval.options);
            return (
              <Card key={r.id} className="border-spark-orange/30 bg-spark-orange/5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-parchment/40">
                  {flowName(r.flow_id)}
                </p>
                <p className="mt-1 text-sm text-parchment">
                  {approval.prompt || "This automation is waiting for your approval."}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {options.map((opt) => (
                    <button
                      key={opt}
                      onClick={() => decide(r.id, APPROVAL_OPTION_DECISIONS[opt])}
                      disabled={busy === r.id}
                      className={`rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${OPTION_BUTTON_STYLES[opt]}`}
                      title={OPTION_BUTTON_TITLES[opt]}
                    >
                      {APPROVAL_OPTION_LABELS[opt]}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-parchment/50">
                  You can also reply by text:{" "}
                  {options.map((opt, i) => (
                    <span key={opt}>
                      <span className="text-parchment/70">{i + 1}</span> to{" "}
                      {APPROVAL_OPTION_INSTRUCTIONS[opt]}
                      {i < options.length - 2 ? ", " : i === options.length - 2 ? ", or " : "."}
                    </span>
                  ))}
                </p>
              </Card>
            );
          })}
        </section>
      )}

      {routing.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-spark-orange">
            Routing to team ({routing.length})
          </h2>
          {routing.map((r) => {
            const deadline = r.respond_by_at ? new Date(r.respond_by_at) : null;
            return (
              <Card key={r.id} className="border-spark-orange/30 bg-spark-orange/5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-parchment/40">
                  {flowName(r.flow_id)}
                </p>
                <p className="mt-1 text-sm text-parchment">
                  Offered to{" "}
                  <span className="font-semibold">
                    {(r.awaiting_agent_e164 && names[r.awaiting_agent_e164]) ??
                      r.awaiting_agent_e164 ??
                      "an employee"}
                  </span>
                  {deadline && (
                    <span className="text-parchment/60">
                      {" "}
                      replies by {deadline.toLocaleString()}
                    </span>
                  )}
                </p>
                <p className="mt-1 text-xs text-parchment/50">
                  Waiting for the employee to reply 1 (claim) or 2 (pass). Escalates
                  automatically if they don&apos;t respond in time.
                </p>
              </Card>
            );
          })}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-parchment/40">
          Run history
        </h2>
        {runs.length === 0 ? (
          <Card>
            <p className="py-6 text-center text-sm text-parchment/60">No runs yet.</p>
          </Card>
        ) : (
          grouped.map((group) => {
            const groupRunIds = group.runs.map((r) => r.id);
            const allExpanded = groupRunIds.every((id) => expandedRuns.has(id));
            const groupOpen = expandedGroups.has(group.id);
            return (
            <div key={group.id} className="space-y-2">
              <h3 className="flex items-center gap-2 pt-1 text-sm font-semibold text-parchment">
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="flex items-center gap-2 text-left"
                  aria-expanded={groupOpen}
                >
                  {groupOpen ? (
                    <ChevronDown className="h-4 w-4 text-parchment/40" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-parchment/40" />
                  )}
                  {group.name}
                  <span className="text-xs font-normal text-parchment/40">
                    {group.runs.length} run{group.runs.length === 1 ? "" : "s"}
                  </span>
                </button>
                {groupOpen && (
                  <button
                    onClick={() => setGroupExpanded(groupRunIds, !allExpanded)}
                    className="ml-auto text-xs font-normal text-signal-teal hover:underline"
                  >
                    {allExpanded ? "Collapse details" : "Expand details"}
                  </button>
                )}
              </h3>
              {groupOpen && group.runs.map((r) => (
                <Card key={r.id} id={`run-${r.id}`} className="space-y-2">
                  <button
                    onClick={() => toggle(r.id)}
                    className="flex w-full items-center justify-between text-left"
                  >
                    <span className="flex items-center gap-2">
                      {expandedRuns.has(r.id) ? (
                        <ChevronDown className="h-4 w-4 text-parchment/40" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-parchment/40" />
                      )}
                      <span className="flex flex-col text-sm text-parchment/80 sm:flex-row sm:items-center sm:gap-2">
                        <span>
                          <span className="text-parchment/40">Triggered</span>{" "}
                          {new Date(r.created_at).toLocaleString()}
                        </span>
                        {TERMINAL_STATUSES.has(r.status) && (
                          <span className="text-xs text-parchment/60">
                            <span className="hidden sm:inline">· </span>
                            <span className="text-parchment/40">Completed</span>{" "}
                            {new Date(r.updated_at).toLocaleString()}
                          </span>
                        )}
                      </span>
                      {retrySummary(r.error_retry_count) && (
                        <span className="text-[10px] text-spark-orange/80">
                          {retrySummary(r.error_retry_count)}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {(r.context.trigger as { test_mode?: unknown } | undefined)?.test_mode ===
                        true && (
                        <span
                          title="Test run: side effects were simulated — nothing was actually sent"
                          className="rounded-full bg-purple-400/15 px-2 py-0.5 text-[10px] font-semibold text-purple-300"
                        >
                          TEST
                        </span>
                      )}
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          STATUS_STYLES[r.status] ?? "bg-parchment/10 text-parchment/50"
                        }`}
                      >
                        {statusLabel(r.status)}
                      </span>
                    </span>
                  </button>
                  {routingSummary(r.context) && (
                    <p className="text-xs text-parchment/50">{routingSummary(r.context)}</p>
                  )}
                  {r.status === "queued" && r.earliest_claim_at && (
                    <p className="text-xs text-parchment/50">
                      Waiting for its sending window (quiet hours / business hours);
                      resumes at {new Date(r.earliest_claim_at).toLocaleString()}
                    </p>
                  )}
                  {r.status === "awaiting_call" && r.respond_by_at && (
                    <p className="text-xs text-parchment/50">
                      AI call in progress — the outcome lands when the call ends (by{" "}
                      {new Date(r.respond_by_at).toLocaleString()} at the latest)
                    </p>
                  )}
                  {r.status === "awaiting_reply" && r.respond_by_at && (
                    <p className="text-xs text-parchment/50">
                      Waiting for their text back until{" "}
                      {new Date(r.respond_by_at).toLocaleString()} (then the no-reply path
                      runs)
                    </p>
                  )}
                  {STOPPABLE_STATUSES.has(r.status) && (
                    <div className="flex justify-end">
                      <button
                        onClick={() => stopRun(r.id)}
                        disabled={busy === r.id}
                        title={
                          r.status === "running"
                            ? "Stop this run — it finishes the step it's on, then nothing further runs"
                            : "Stop this run — nothing further will send, and it can't be resumed"
                        }
                        className="rounded-md bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-400 hover:bg-red-500/25 disabled:opacity-50"
                      >
                        {busy === r.id ? "Stopping…" : "Stop this run"}
                      </button>
                    </div>
                  )}
                  {expandedRuns.has(r.id) && (
                    <div className="space-y-2 border-t border-parchment/10 pt-2">
                      {r.last_error && r.status !== "done" && (
                        <p className="text-xs text-red-400">Error: {r.last_error}</p>
                      )}
                      <RunDataSection context={r.context} />
                      {(steps[r.id] ?? []).map((s) => (
                        <div key={s.id} className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span
                              className={
                                stepNotTaken(s) ? "text-parchment/35" : "text-parchment/70"
                              }
                            >
                              {s.step_index + 1}. {stepLabel(s.step_type)}
                              {branchChoiceLabel(s) && (
                                <span className="text-signal-teal/80">
                                  {" "}
                                  → {branchChoiceLabel(s)}
                                </span>
                              )}
                            </span>
                            <span
                              className={
                                s.status === "failed"
                                  ? "text-red-400"
                                  : stepNotTaken(s)
                                    ? "text-parchment/30"
                                    : "text-parchment/40"
                              }
                            >
                              {stepNotTaken(s) ? "not taken" : s.status}
                            </span>
                          </div>
                          {s.error && s.status === "failed" && (
                            <p className="text-xs text-red-400/90">{s.error}</p>
                          )}
                          {stepProducedEntries(s).length > 0 && (
                            <p className="pl-3 text-[11px] text-parchment/45">
                              {stepProducedEntries(s).map((e, i) => (
                                <span key={e.key}>
                                  {i > 0 && " · "}
                                  <span className="font-mono text-signal-teal/70">{e.key}</span>
                                  {": "}
                                  {e.value === "" ? (
                                    <span className="italic text-spark-orange/80">(empty)</span>
                                  ) : (
                                    e.value
                                  )}
                                </span>
                              ))}
                            </p>
                          )}
                          {(s.screenshot_before_url || s.screenshot_url) && (
                            <div className="flex flex-wrap gap-3 pt-1">
                              {s.screenshot_before_url && (
                                <Screenshot
                                  url={s.screenshot_before_url}
                                  label="Before actions"
                                  stepIndex={s.step_index}
                                  failed={false}
                                  sourceUrl={s.source_before_url}
                                />
                              )}
                              {s.screenshot_url && (
                                <Screenshot
                                  url={s.screenshot_url}
                                  label={
                                    s.status === "failed"
                                      ? "At failure"
                                      : s.screenshot_before_url
                                        ? "After actions"
                                        : "Page"
                                  }
                                  stepIndex={s.step_index}
                                  failed={s.status === "failed"}
                                  sourceUrl={s.source_url}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                      {(steps[r.id] ?? []).length === 0 && (
                        <p className="text-xs text-parchment/40">No steps recorded.</p>
                      )}
                    </div>
                  )}
                </Card>
              ))}
            </div>
            );
          })
        )}
      </section>
    </div>
  );
}
