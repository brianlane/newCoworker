/**
 * Tell the owner, out of band, when an AI surface changed one of their
 * automations.
 *
 * The confirm handshake means an edit was approved in a conversation. That is
 * not the same as the owner still knowing about it tomorrow: a text thread
 * scrolls, and the surface most likely to be used away from a laptop is also
 * the one whose history is hardest to go back through. So a change made by
 * the coworker leaves two traces the conversation cannot swallow, an owner
 * notification and a system_log event.
 *
 * Dashboard edits are deliberately NOT announced. The owner is looking at the
 * automation when they make one, and an alert for a change you just watched
 * yourself make is the kind of noise that teaches people to ignore alerts.
 *
 * Best effort throughout: a change that landed must never be reported as
 * failed because an alert did not send.
 */
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";

/**
 * Edit sources that represent the AI acting on the owner's behalf, away from
 * the flow itself. `dashboard` and `white_glove` are absent on purpose: the
 * first is the owner in the builder, the second is us, with the tenant
 * already in the loop.
 */
const ANNOUNCED_SOURCES: ReadonlySet<string> = new Set([
  "ai_edit_sms",
  "ai_edit_email",
  "ai_edit_slack",
  "ai_edit_dashboard",
  "mcp",
  "mcp_restore"
]);

export function shouldAnnounceFlowChange(source: string | undefined): boolean {
  return source !== undefined && ANNOUNCED_SOURCES.has(source);
}

export type FlowChangeNoticeInput = {
  businessId: string;
  flowId: string;
  flowName: string;
  /** "edited" or "reverted": what the owner should picture happening. */
  action: "edited" | "reverted";
  /** The ai_flows.edit_source stamped on the write. */
  source: string | undefined;
  actor?: string | null;
  /** Plain-English diff lines, when the caller has them. */
  summary?: string[];
};

export type FlowChangeNoticeDeps = {
  dispatch?: typeof dispatchUrgentNotification;
  log?: typeof recordSystemLog;
};

/** Human name for a surface, for a line the owner reads on their phone. */
function surfaceLabel(source: string): string {
  switch (source) {
    case "ai_edit_sms":
      return "by text";
    case "ai_edit_email":
      return "by email";
    case "ai_edit_slack":
      return "in Slack";
    case "ai_edit_dashboard":
      return "in dashboard chat";
    case "mcp":
    case "mcp_restore":
      return "through a connected app";
    /* c8 ignore next 2 -- unreachable: gated by shouldAnnounceFlowChange */
    default:
      return "by your coworker";
  }
}

/**
 * Announce one applied change. Never throws, and never reports failure to the
 * caller: the flow write already happened, and the caller's result must keep
 * describing that, not the alert.
 */
export async function announceFlowChange(
  input: FlowChangeNoticeInput,
  deps: FlowChangeNoticeDeps = {}
): Promise<void> {
  if (!shouldAnnounceFlowChange(input.source)) return;
  const source = input.source as string;
  /* c8 ignore start -- production defaults; tests inject */
  const dispatch = deps.dispatch ?? dispatchUrgentNotification;
  const log = deps.log ?? recordSystemLog;
  /* c8 ignore stop */

  const verb = input.action === "reverted" ? "put back" : "changed";
  const summary = `Your automation "${input.flowName}" was ${verb} ${surfaceLabel(source)}.`;

  try {
    await log({
      businessId: input.businessId,
      source: "app",
      level: "info",
      event: "aiflow_changed_by_ai",
      message: summary,
      payload: {
        flow_id: input.flowId,
        flow_name: input.flowName,
        action: input.action,
        edit_source: source,
        edit_actor: input.actor ?? null,
        ...(input.summary && input.summary.length > 0 ? { change_summary: input.summary } : {})
      }
    });
  } catch (err) {
    logger.warn("announceFlowChange: system log failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  try {
    await dispatch({
      businessId: input.businessId,
      kind: "aiflow_changed_by_ai",
      summary,
      // "undo that" works from any coworker surface, so the alert says the
      // one thing the owner needs in order to act on it immediately.
      smsBody: `New Coworker: ${summary} Reply to your coworker with "undo that" to put it back, or review it in the dashboard.`,
      emailSubject: `Automation ${verb}: ${input.flowName}`,
      ctaPath: `/dashboard/aiflows?edit=${input.flowId}`,
      payload: {
        flow_id: input.flowId,
        action: input.action,
        edit_source: source
      }
    });
  } catch (err) {
    logger.warn("announceFlowChange: dispatch failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
