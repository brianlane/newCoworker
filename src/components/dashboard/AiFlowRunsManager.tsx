"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { ChevronDown, ChevronRight } from "lucide-react";
import { retrySummary, routingSummary } from "@/lib/ai-flows/run-stats";
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
  done: "bg-claw-green/15 text-claw-green",
  failed: "bg-red-500/15 text-red-400",
  canceled: "bg-parchment/10 text-parchment/40"
};

export type AiFlowRef = { id: string; name: string };

/** A labeled, clickable screenshot thumbnail shown in the run "investigate" view. */
function Screenshot({
  url,
  label,
  stepIndex,
  failed
}: {
  url: string;
  label: string;
  stepIndex: number;
  failed: boolean;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title="Open full-size screenshot in a new tab"
      className="block space-y-1"
    >
      <span
        className={`text-[10px] font-semibold uppercase tracking-wider ${
          failed ? "text-red-400/80" : "text-parchment/40"
        }`}
      >
        {label}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={`${label} — step ${stepIndex + 1}`}
        className={`max-h-64 w-auto rounded-md border object-contain object-top transition hover:opacity-90 ${
          failed ? "border-red-500/40" : "border-parchment/15"
        }`}
      />
    </a>
  );
}

export function AiFlowRunsManager({
  businessId,
  initialRuns,
  flows,
  flowId
}: {
  businessId: string;
  initialRuns: AiFlowRunRow[];
  flows: AiFlowRef[];
  /** When set, the page is scoped to one flow — keep the filter on reload. */
  flowId?: string;
}) {
  const [runs, setRuns] = useState<AiFlowRunRow[]>(initialRuns);
  const [flowList, setFlowList] = useState<AiFlowRef[]>(flows);
  const [expanded, setExpanded] = useState<string | null>(null);
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
    const runsJson = (await runsRes.json()) as { ok: boolean; data?: AiFlowRunRow[] };
    if (runsJson.ok && runsJson.data) setRuns(runsJson.data);
    const flowsJson = (await flowsRes.json()) as { ok: boolean; data?: AiFlowRef[] };
    if (flowsJson.ok && flowsJson.data) {
      setFlowList(flowsJson.data.map((f) => ({ id: f.id, name: f.name })));
    }
  };

  const toggle = async (runId: string) => {
    if (expanded === runId) {
      setExpanded(null);
      return;
    }
    setExpanded(runId);
    if (!steps[runId]) {
      const res = await fetch(
        `/api/aiflows/runs/${runId}?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as { ok: boolean; data?: { steps: AiFlowRunStepRow[] } };
      if (json.ok && json.data) setSteps((s) => ({ ...s, [runId]: json.data!.steps }));
    }
  };

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

  // Group run history per AiFlow. Groups follow the flows list order (newest
  // flow first, matching the AiFlows page); runs within a group stay
  // newest-first as the API returns them. Runs whose flow no longer appears in
  // the list (deleted between fetches — FK cascade removes them on the next
  // load) are collected into trailing "Deleted flow" groups rather than dropped.
  const grouped: Array<{ id: string; name: string; runs: AiFlowRunRow[] }> = [];
  const byFlow = new Map<string, AiFlowRunRow[]>();
  for (const r of runs) {
    const list = byFlow.get(r.flow_id);
    if (list) list.push(r);
    else byFlow.set(r.flow_id, [r]);
  }
  for (const f of flowList) {
    const list = byFlow.get(f.id);
    if (list) {
      grouped.push({ id: f.id, name: f.name, runs: list });
      byFlow.delete(f.id);
    }
  }
  for (const [id, list] of byFlow) {
    grouped.push({ id, name: "Deleted flow", runs: list });
  }

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
                  <span className="font-semibold">{r.awaiting_agent_e164 ?? "an agent"}</span>
                  {deadline && (
                    <span className="text-parchment/60">
                      {" "}
                      — replies by {deadline.toLocaleString()}
                    </span>
                  )}
                </p>
                <p className="mt-1 text-xs text-parchment/50">
                  Waiting for the agent to reply 1 (claim) or 2 (pass). Escalates
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
          grouped.map((group) => (
            <div key={group.id} className="space-y-2">
              <h3 className="flex items-baseline gap-2 pt-1 text-sm font-semibold text-parchment">
                {group.name}
                <span className="text-xs font-normal text-parchment/40">
                  {group.runs.length} run{group.runs.length === 1 ? "" : "s"}
                </span>
              </h3>
              {group.runs.map((r) => (
                <Card key={r.id} className="space-y-2">
                  <button
                    onClick={() => toggle(r.id)}
                    className="flex w-full items-center justify-between text-left"
                  >
                    <span className="flex items-center gap-2">
                      {expanded === r.id ? (
                        <ChevronDown className="h-4 w-4 text-parchment/40" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-parchment/40" />
                      )}
                      <span className="text-sm text-parchment/80">
                        {new Date(r.created_at).toLocaleString()}
                      </span>
                      {retrySummary(r.error_retry_count) && (
                        <span className="text-[10px] text-spark-orange/80">
                          {retrySummary(r.error_retry_count)}
                        </span>
                      )}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        STATUS_STYLES[r.status] ?? "bg-parchment/10 text-parchment/50"
                      }`}
                    >
                      {r.status.toUpperCase()}
                    </span>
                  </button>
                  {routingSummary(r.context) && (
                    <p className="text-xs text-parchment/50">{routingSummary(r.context)}</p>
                  )}
                  {r.status === "queued" && r.earliest_claim_at && (
                    <p className="text-xs text-parchment/50">
                      Quiet hours — resumes at{" "}
                      {new Date(r.earliest_claim_at).toLocaleString()}
                    </p>
                  )}
                  {expanded === r.id && (
                    <div className="space-y-1 border-t border-parchment/10 pt-2">
                      {r.last_error && r.status !== "done" && (
                        <p className="text-xs text-red-400">Error: {r.last_error}</p>
                      )}
                      {(steps[r.id] ?? []).map((s) => (
                        <div key={s.id} className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-parchment/70">
                              {s.step_index + 1}. {s.step_type}
                            </span>
                            <span
                              className={
                                s.status === "failed" ? "text-red-400" : "text-parchment/40"
                              }
                            >
                              {s.status}
                            </span>
                          </div>
                          {s.error && s.status === "failed" && (
                            <p className="text-xs text-red-400/90">{s.error}</p>
                          )}
                          {(s.screenshot_before_url || s.screenshot_url) && (
                            <div className="flex flex-wrap gap-3 pt-1">
                              {s.screenshot_before_url && (
                                <Screenshot
                                  url={s.screenshot_before_url}
                                  label="Before actions"
                                  stepIndex={s.step_index}
                                  failed={false}
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
          ))
        )}
      </section>
    </div>
  );
}
