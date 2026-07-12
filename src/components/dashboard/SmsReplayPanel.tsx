"use client";

import { useState } from "react";

/** Enabled SMS-triggered flows offered as replay targets (built server-side). */
export type SmsReplayFlowOption = { id: string; name: string };

const LOOKBACK_OPTIONS = [
  { hours: 24, label: "Last 24 hours" },
  { hours: 48, label: "Last 2 days" },
  { hours: 72, label: "Last 3 days" },
  { hours: 168, label: "Last 7 days" }
] as const;

type ReplayState =
  | { status: "idle" }
  | { status: "confirm"; flowId: string; hours: number }
  | { status: "submitting"; flowId: string; hours: number }
  | { status: "done"; message: string }
  | { status: "error"; message: string };

/**
 * "Replay missed texts" panel (SMS twin of the Emails page replay banner).
 *
 * Texts that arrived while an SMS-triggered flow was disabled got the normal
 * Coworker reply but never started the automation. This re-runs a recent
 * window of inbound texts through a chosen flow as BACKFILL runs: each text
 * is re-checked against the flow's trigger conditions, already-handled
 * messages are deduped by their event id, and leads already saved as
 * contacts are filed without any outreach — nobody gets double-texted.
 *
 * Unlike the Emails page there is no unmatched count to show up front (most
 * ordinary texts legitimately match no flow), so this renders as a compact
 * always-available action instead of an alert banner.
 */
export function SmsReplayPanel({
  businessId,
  flows
}: {
  businessId: string;
  flows: SmsReplayFlowOption[];
}) {
  const [state, setState] = useState<ReplayState>({ status: "idle" });

  async function submit(flowId: string, hours: number) {
    setState({ status: "submitting", flowId, hours });
    try {
      const res = await fetch(
        `/api/dashboard/messages/replay?businessId=${encodeURIComponent(businessId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId, lookbackHours: hours })
        }
      );
      const json = (await res.json().catch(() => null)) as {
        data?: {
          summary?: {
            total: number;
            enqueued: number;
            duplicates: number;
            skipped: number;
            errors: number;
          };
        };
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.data?.summary) {
        setState({
          status: "error",
          message: json?.error?.message ?? "Replay failed — try again in a minute."
        });
        return;
      }
      const s = json.data.summary;
      if (s.total === 0) {
        setState({ status: "done", message: "No inbound texts in that window." });
        return;
      }
      const parts = [`${s.enqueued} queued`];
      if (s.duplicates > 0) parts.push(`${s.duplicates} already handled`);
      if (s.skipped > 0) parts.push(`${s.skipped} didn't match the flow`);
      if (s.errors > 0) parts.push(`${s.errors} failed`);
      setState({
        status: "done",
        message: `Checked ${s.total} text${s.total === 1 ? "" : "s"}: ${parts.join(", ")}. Leads already in your contacts are filed without re-texting.`
      });
    } catch {
      setState({ status: "error", message: "Replay failed — try again in a minute." });
    }
  }

  if (flows.length === 0) return null;

  if (state.status === "done") {
    return (
      <div className="rounded-lg border border-signal-teal/30 bg-signal-teal/5 px-4 py-3 text-sm text-parchment/80">
        {state.message}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-parchment/10 bg-deep-ink/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-parchment/70">
          Texts that arrived while a flow was off can be replayed through it — leads already in
          your contacts won&apos;t be texted again.
        </p>
        {(state.status === "idle" || state.status === "error") && (
          <button
            type="button"
            onClick={() =>
              setState({ status: "confirm", flowId: flows[0].id, hours: LOOKBACK_OPTIONS[0].hours })
            }
            className="rounded-lg border border-parchment/25 px-3 py-1.5 text-xs font-semibold text-parchment/80 transition-colors hover:border-signal-teal/40 hover:text-signal-teal"
          >
            Replay missed texts…
          </button>
        )}
      </div>
      {state.status === "error" && (
        <p className="mt-2 text-xs text-spark-orange">{state.message}</p>
      )}
      {(state.status === "confirm" || state.status === "submitting") && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label htmlFor="sms-replay-flow" className="text-xs text-parchment/60">
            Flow
          </label>
          <select
            id="sms-replay-flow"
            value={state.flowId}
            onChange={(e) =>
              setState({ status: "confirm", flowId: e.target.value, hours: state.hours })
            }
            disabled={state.status === "submitting"}
            className="rounded-md border border-parchment/20 bg-deep-ink px-2 py-1.5 text-sm text-parchment"
          >
            {flows.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <label htmlFor="sms-replay-window" className="text-xs text-parchment/60">
            Window
          </label>
          <select
            id="sms-replay-window"
            value={state.hours}
            onChange={(e) =>
              setState({ status: "confirm", flowId: state.flowId, hours: Number(e.target.value) })
            }
            disabled={state.status === "submitting"}
            className="rounded-md border border-parchment/20 bg-deep-ink px-2 py-1.5 text-sm text-parchment"
          >
            {LOOKBACK_OPTIONS.map((o) => (
              <option key={o.hours} value={o.hours}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => submit(state.flowId, state.hours)}
            disabled={state.status === "submitting"}
            className="rounded-lg bg-signal-teal px-3 py-1.5 text-xs font-semibold text-deep-ink transition-colors hover:bg-opacity-90 disabled:opacity-50"
          >
            {state.status === "submitting" ? "Replaying…" : "Replay"}
          </button>
          <button
            type="button"
            onClick={() => setState({ status: "idle" })}
            disabled={state.status === "submitting"}
            className="text-xs text-parchment/50 hover:text-parchment"
          >
            Cancel
          </button>
          <p className="w-full text-[11px] text-parchment/40">
            Each text is re-checked against the flow&apos;s trigger conditions; texts the flow
            already handled are skipped automatically. New leads run the full flow.
          </p>
        </div>
      )}
    </div>
  );
}
