"use client";

/**
 * Staff Task Center — the working view for a lead pipeline.
 *
 * One card per lead in motion, combining the five facets the Lead
 * Management PRD wants every employee to see at a glance: where the active
 * workflow sits, the lead's state (tags + owner), the goal events it has
 * hit, what the AI has collected, and why the AI replied the way it did.
 *
 * Staff logins linked to a roster member default to "My tasks" (contacts
 * they own); the toggle flips to the whole board. Data comes from
 * /api/dashboard/tasks; a manual refresh re-fetches.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import {
  Bell,
  CheckCircle2,
  Flag,
  History,
  Hourglass,
  RefreshCw,
  Tag,
  User,
  Workflow
} from "lucide-react";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { goalViaText } from "@/lib/ai-flows/tasks";
import type {
  TaskCardData,
  TaskReasoningView,
  TaskRunView
} from "@/app/api/dashboard/tasks/route";

type Scope = "mine" | "all";

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Waiting for approval",
  awaiting_agent: "Offered to the team",
  awaiting_reply: "Waiting for their reply",
  awaiting_call: "AI call in progress"
};

const STATUS_TONE: Record<string, string> = {
  queued: "bg-parchment/10 text-parchment/60",
  running: "bg-signal-teal/15 text-signal-teal",
  awaiting_approval: "bg-spark-orange/15 text-spark-orange",
  awaiting_agent: "bg-spark-orange/15 text-spark-orange",
  awaiting_reply: "bg-spark-orange/15 text-spark-orange",
  awaiting_call: "bg-spark-orange/15 text-spark-orange"
};

function RunLine({
  run,
  businessId,
  canDismiss,
  onDismissed
}: {
  run: TaskRunView;
  businessId: string;
  /** Manager+ only — the cancel endpoint requires manage_aiflows. */
  canDismiss: boolean;
  onDismissed: () => void;
}) {
  const [state, setState] = useState<"idle" | "dismissing" | "error">("idle");

  async function dismiss() {
    if (
      !window.confirm(
        `Dismiss this task? "${run.flowName}" stops for this lead and nothing further sends.`
      )
    ) {
      return;
    }
    setState("dismissing");
    try {
      const res = await fetch(`/api/aiflows/runs/${encodeURIComponent(run.id)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !json?.ok) {
        setState("error");
        return;
      }
      onDismissed();
    } catch {
      setState("error");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Workflow className="h-3.5 w-3.5 text-parchment/40" />
      <Link
        href={`/dashboard/aiflows/${run.flowId}`}
        className="font-medium text-parchment/80 hover:text-signal-teal hover:underline"
      >
        {run.flowName}
      </Link>
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
          STATUS_TONE[run.status] ?? "bg-parchment/10 text-parchment/60"
        }`}
      >
        {STATUS_LABEL[run.status] ?? run.status}
      </span>
      <span className="text-parchment/50">
        {run.stepNumber === 0
          ? "finished"
          : `step ${run.stepNumber}/${run.totalSteps} · ${run.nodeLabel}`}
      </span>
      {run.waitingUntil && (
        <span className="inline-flex items-center gap-1 text-parchment/40">
          <Hourglass className="h-3 w-3" />
          until <LocalDateTime iso={run.waitingUntil} />
        </span>
      )}
      {canDismiss && (
        <button
          type="button"
          data-testid="task-dismiss"
          onClick={() => void dismiss()}
          disabled={state === "dismissing"}
          className="ml-auto text-[11px] font-medium text-parchment/40 hover:text-spark-orange disabled:opacity-50 cursor-pointer"
        >
          {state === "dismissing" ? "Dismissing…" : "Dismiss"}
        </button>
      )}
      {state === "error" && (
        <span className="text-[11px] text-spark-orange">Couldn&apos;t dismiss — try again.</span>
      )}
    </div>
  );
}

function ReasoningLine({ r }: { r: TaskReasoningView }) {
  return (
    <div className="rounded-md border border-parchment/10 bg-deep-ink/30 px-2.5 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-parchment/10 px-1.5 py-0.5 font-mono text-[10px] text-parchment/70">
          {r.intent}
        </span>
        {r.escalated && (
          <span className="rounded bg-spark-orange/15 px-1.5 py-0.5 text-[10px] font-semibold text-spark-orange">
            handed to a human
          </span>
        )}
        <span className="ml-auto text-[10px] text-parchment/35">
          <LocalDateTime iso={r.at} />
        </span>
      </div>
      <p className="mt-1 text-parchment/60">{r.rationale}</p>
      {r.replyPreview && (
        <p className="mt-1 truncate text-[11px] italic text-parchment/40">
          “{r.replyPreview}”
        </p>
      )}
    </div>
  );
}

function TaskCard({
  task,
  businessId,
  canDismissRuns,
  onChanged
}: {
  task: TaskCardData;
  businessId: string;
  canDismissRuns: boolean;
  onChanged: () => void;
}) {
  const [showVars, setShowVars] = useState(false);
  return (
    <Card className="space-y-3">
      {/* Header: who + lead state */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/dashboard/customers/${encodeURIComponent(task.e164)}`}
          className="text-sm font-semibold text-parchment hover:text-signal-teal hover:underline"
        >
          {task.name}
        </Link>
        <span className="text-xs text-parchment/40">{task.e164}</span>
        {task.tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-signal-teal/10 px-2 py-0.5 text-[10px] font-medium text-signal-teal"
          >
            <Tag className="h-2.5 w-2.5" />
            {t}
          </span>
        ))}
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-parchment/50">
          <User className="h-3.5 w-3.5" />
          {task.ownerName ?? (task.claimedBy ? `claimed by ${task.claimedBy}` : "unassigned")}
        </span>
      </div>

      {/* Active workflows */}
      {task.runs.length > 0 ? (
        <div className="space-y-1.5">
          {task.runs.map((run) => (
            <RunLine
              key={run.id}
              run={run}
              businessId={businessId}
              canDismiss={canDismissRuns}
              onDismissed={onChanged}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-parchment/40">
          No automation is currently running for this lead.
        </p>
      )}

      {/* Goal events */}
      {task.goals.length > 0 && (
        <div className="space-y-1">
          {task.goals.map((g, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <Flag className="h-3.5 w-3.5 text-rose-300" />
              <span className="font-medium text-rose-200/90">{g.label}</span>
              <span className="text-parchment/50">
                {g.via === "passed_inline" ? "reached in sequence" : `jumped — ${goalViaText(g.via)}`}
              </span>
              <span className="text-[10px] text-parchment/35">
                <LocalDateTime iso={g.at} /> · {g.flowName}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Collected info + rolling summary */}
      {task.summary?.trim() && (
        <p className="whitespace-pre-wrap rounded-md bg-deep-ink/30 px-2.5 py-1.5 text-xs text-parchment/60">
          {task.summary}
        </p>
      )}
      {task.vars.length > 0 && (
        <div>
          <button
            onClick={() => setShowVars((v) => !v)}
            className="text-[11px] text-signal-teal hover:underline"
          >
            {showVars ? "Hide collected info" : `Collected info (${task.vars.length})`}
          </button>
          {showVars && (
            <dl className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
              {task.vars.map((v) => (
                <div key={v.key} className="flex gap-2 text-xs">
                  <dt className="shrink-0 font-mono text-parchment/40">{v.key}</dt>
                  <dd className="truncate text-parchment/70">{v.value || "(empty)"}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      {/* Recent cross-channel activity (calls + texts), linking back to the
          contact's full timeline — the tasks side of the bidirectional
          activity <-> contact/task navigation. */}
      {task.activity.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-parchment/50">
              <History className="h-3 w-3" /> Recent activity
            </div>
            <Link
              href={`/dashboard/customers/${encodeURIComponent(task.e164)}`}
              className="text-[11px] text-signal-teal hover:underline"
            >
              Full activity →
            </Link>
          </div>
          {task.activity.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-2 text-xs">
              <Link
                href={a.href}
                className="text-parchment/70 hover:text-signal-teal hover:underline"
              >
                {a.label}
              </Link>
              <span className="text-[10px] text-parchment/35">
                <LocalDateTime iso={a.at} />
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Response reasoning */}
      {task.reasoning.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-parchment/50">
            <Bell className="h-3 w-3" /> Why the AI replied the way it did
          </div>
          {task.reasoning.map((r, i) => (
            <ReasoningLine key={i} r={r} />
          ))}
        </div>
      )}
    </Card>
  );
}

export function TaskCenter({
  businessId,
  defaultScope,
  hasLinkedEmployee,
  canDismissRuns
}: {
  businessId: string;
  /** Staff with a linked roster member start on "mine"; everyone else "all". */
  defaultScope: Scope;
  hasLinkedEmployee: boolean;
  /** Manager+ (manage_aiflows) — gates the Dismiss-task action. */
  canDismissRuns: boolean;
}) {
  const [scope, setScope] = useState<Scope>(defaultScope);
  const [tasks, setTasks] = useState<TaskCardData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (nextScope: Scope) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/dashboard/tasks?businessId=${encodeURIComponent(businessId)}&scope=${nextScope}`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as {
          ok: boolean;
          data?: { tasks: TaskCardData[] };
          error?: { message?: string };
        };
        if (!res.ok || !json.ok || !json.data) {
          setError(json.error?.message ?? "Couldn't load tasks");
          setTasks(null);
        } else {
          setTasks(json.data.tasks);
        }
      } catch {
        setError("Couldn't load tasks");
        setTasks(null);
      } finally {
        setLoading(false);
      }
    },
    [businessId]
  );

  useEffect(() => {
    void load(scope);
  }, [load, scope]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-parchment/15">
          {(["mine", "all"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                scope === s
                  ? "bg-signal-teal/15 text-signal-teal"
                  : "text-parchment/50 hover:text-parchment/80"
              }`}
            >
              {s === "mine" ? "My tasks" : "All tasks"}
            </button>
          ))}
        </div>
        <button
          onClick={() => void load(scope)}
          className="inline-flex items-center gap-1.5 rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/60 hover:text-parchment"
          aria-label="Refresh tasks"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {scope === "mine" && !hasLinkedEmployee && (
        <Card>
          <p className="text-sm text-parchment/60">
            Your login isn&apos;t linked to a team-roster member yet, so there are no
            &quot;my&quot; tasks to show. Ask a manager to link your login to your roster
            profile (Settings → Team access), or switch to All tasks.
          </p>
        </Card>
      )}

      {error && (
        <Card>
          <p className="text-sm text-spark-orange">{error}</p>
        </Card>
      )}

      {!error && tasks !== null && tasks.length === 0 && !(scope === "mine" && !hasLinkedEmployee) && (
        <Card>
          <div className="flex items-center gap-2 py-4 text-sm text-parchment/50">
            <CheckCircle2 className="h-4 w-4 text-claw-green" />
            Nothing in motion right now — new leads will appear here the moment a
            workflow picks them up.
          </div>
        </Card>
      )}

      {tasks?.map((task) => (
        <TaskCard
          key={task.e164}
          task={task}
          businessId={businessId}
          canDismissRuns={canDismissRuns}
          onChanged={() => void load(scope)}
        />
      ))}
    </div>
  );
}
