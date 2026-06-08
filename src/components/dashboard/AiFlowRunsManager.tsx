"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { AiFlowRunRow, AiFlowRunStepRow } from "@/lib/ai-flows/db";

const STATUS_STYLES: Record<string, string> = {
  queued: "bg-parchment/10 text-parchment/60",
  running: "bg-signal-teal/15 text-signal-teal",
  awaiting_approval: "bg-spark-orange/15 text-spark-orange",
  done: "bg-claw-green/15 text-claw-green",
  failed: "bg-red-500/15 text-red-400",
  canceled: "bg-parchment/10 text-parchment/40"
};

export function AiFlowRunsManager({
  businessId,
  initialRuns
}: {
  businessId: string;
  initialRuns: AiFlowRunRow[];
}) {
  const [runs, setRuns] = useState<AiFlowRunRow[]>(initialRuns);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, AiFlowRunStepRow[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    const res = await fetch(`/api/aiflows/runs?businessId=${encodeURIComponent(businessId)}`, {
      cache: "no-store"
    });
    const json = (await res.json()) as { ok: boolean; data?: AiFlowRunRow[] };
    if (json.ok && json.data) setRuns(json.data);
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

  const decide = async (runId: string, decision: "approve" | "deny") => {
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
            const approval = (r.context.approval ?? {}) as { prompt?: string };
            return (
              <Card key={r.id} className="border-spark-orange/30 bg-spark-orange/5">
                <p className="text-sm text-parchment">
                  {approval.prompt || "This automation is waiting for your approval."}
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => decide(r.id, "approve")}
                    disabled={busy === r.id}
                    className="rounded-md bg-claw-green/20 px-3 py-1.5 text-sm text-claw-green hover:bg-claw-green/30 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decide(r.id, "deny")}
                    disabled={busy === r.id}
                    className="rounded-md bg-red-500/15 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/25 disabled:opacity-50"
                  >
                    Deny
                  </button>
                </div>
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
          runs.map((r) => (
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
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    STATUS_STYLES[r.status] ?? "bg-parchment/10 text-parchment/50"
                  }`}
                >
                  {r.status.toUpperCase()}
                </span>
              </button>
              {expanded === r.id && (
                <div className="space-y-1 border-t border-parchment/10 pt-2">
                  {r.last_error && (
                    <p className="text-xs text-red-400">Error: {r.last_error}</p>
                  )}
                  {(steps[r.id] ?? []).map((s) => (
                    <div key={s.id} className="flex items-center justify-between text-xs">
                      <span className="text-parchment/70">
                        {s.step_index + 1}. {s.step_type}
                      </span>
                      <span className="text-parchment/40">{s.status}</span>
                    </div>
                  ))}
                  {(steps[r.id] ?? []).length === 0 && (
                    <p className="text-xs text-parchment/40">No steps recorded.</p>
                  )}
                </div>
              )}
            </Card>
          ))
        )}
      </section>
    </div>
  );
}
