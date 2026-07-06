import {
  listAiFlows,
  listAiFlowRuns,
  listAiFlowRunSteps,
  type AiFlowRunStepRow
} from "@/lib/ai-flows/db";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { LocalTime } from "@/components/LocalTime";
import { formatAdminLabel } from "@/lib/admin/dashboard";
import { routingSummary } from "@/lib/ai-flows/run-stats";

const RUN_LIMIT = 15;
// Bound the per-run step queries so a failure-heavy page stays cheap.
const MAX_RUNS_WITH_STEPS = 6;

function runBadgeVariant(
  status: string
): "success" | "error" | "pending" | "neutral" | "high_load" {
  if (status === "done") return "success";
  if (status === "failed") return "error";
  if (status === "canceled") return "neutral";
  if (status === "awaiting_approval" || status === "awaiting_agent") return "high_load";
  return "pending";
}

/**
 * Admin-only "what did this client's automations actually do" card: the most
 * recent AiFlow runs with status, last error, and — for problem runs — the
 * per-step breakdown so the exact failing step (and its error text) is visible
 * without leaving the page.
 */
export async function AiFlowRunsCard({ businessId }: { businessId: string }) {
  const [flows, runs] = await Promise.all([
    listAiFlows(businessId),
    listAiFlowRuns(businessId, { limit: RUN_LIMIT })
  ]);
  if (runs.length === 0 && flows.length === 0) return null;

  const flowNames = new Map(flows.map((f) => [f.id, f.name]));

  // The worker keeps last_error from transient retries even after a run
  // recovers, so on a `done` run it's stale noise rather than a failure.
  const isRelevantError = (r: { status: string; last_error: string | null }) =>
    Boolean(r.last_error) && r.status !== "done";

  // Pull step detail for runs that need explaining (failed, or stuck with an
  // error), newest first, capped.
  const problemRuns = runs
    .filter((r) => r.status === "failed" || isRelevantError(r))
    .slice(0, MAX_RUNS_WITH_STEPS);
  const stepsByRun = new Map<string, AiFlowRunStepRow[]>(
    await Promise.all(
      problemRuns.map(
        async (r) =>
          [r.id, await listAiFlowRunSteps(businessId, r.id)] as [string, AiFlowRunStepRow[]]
      )
    )
  );

  return (
    <Card>
      <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
        AiFlow Runs
      </h2>
      {runs.length === 0 ? (
        <p className="text-sm text-parchment/40">No runs yet.</p>
      ) : (
        <ul className="divide-y divide-parchment/10">
          {runs.map((run) => {
            const steps = stepsByRun.get(run.id);
            const failedSteps = (steps ?? []).filter((s) => s.status === "failed");
            const routing = routingSummary(run.context);
            return (
              <li key={run.id} className="py-3 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-sm text-parchment font-medium truncate">
                      {flowNames.get(run.flow_id) ?? "(deleted flow)"}
                    </p>
                    <span className="text-[11px] text-parchment/35 font-mono shrink-0">
                      step {run.current_step}
                      {run.error_retry_count > 0 ? ` · ${run.error_retry_count} retr${run.error_retry_count === 1 ? "y" : "ies"}` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <LocalTime iso={run.created_at} className="text-xs text-parchment/45 font-mono" />
                    <Badge variant={runBadgeVariant(run.status)}>
                      {formatAdminLabel(run.status)}
                    </Badge>
                  </div>
                </div>
                {routing && (
                  <p className="text-xs text-parchment/50">{routing}</p>
                )}
                {run.status === "queued" && run.earliest_claim_at && (
                  <p className="text-xs text-parchment/50">
                    Quiet hours; resumes at{" "}
                    <LocalTime iso={run.earliest_claim_at} className="text-parchment/70" />
                  </p>
                )}
                {isRelevantError(run) && (
                  <p className="text-xs text-spark-orange/90 whitespace-pre-wrap break-words">
                    {run.last_error}
                  </p>
                )}
                {failedSteps.map((s) => (
                  <p
                    key={s.id}
                    className="text-xs text-parchment/55 whitespace-pre-wrap break-words"
                  >
                    <span className="font-mono text-parchment/70">
                      step {s.step_index} ({s.step_type})
                    </span>
                    {s.error ? `: ${s.error}` : " failed"}
                  </p>
                ))}
                {steps && steps.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-parchment/35 hover:text-parchment/50">
                      All steps ({steps.length})
                    </summary>
                    <ul className="mt-1 space-y-0.5">
                      {steps.map((s) => (
                        <li key={s.id} className="flex items-center gap-2">
                          <span className="font-mono text-parchment/60">
                            {s.step_index}. {s.step_type}
                          </span>
                          <Badge
                            variant={
                              s.status === "failed"
                                ? "error"
                                : s.status === "done"
                                  ? "success"
                                  : "neutral"
                            }
                            className="text-[10px]"
                          >
                            {s.status}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
