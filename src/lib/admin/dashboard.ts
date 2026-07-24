export function getMonthLabel(monthsBack: number, now = new Date()): string {
  const d = new Date(now);
  d.setMonth(d.getMonth() - monthsBack, 1);
  return d.toLocaleString("default", { month: "short" });
}

export function formatAdminLabel(value: string): string {
  return value.replaceAll("_", " ");
}

/**
 * Badge variant for a coworker_logs status on the ADMIN surfaces.
 *
 * `urgent_alert` deliberately does NOT get the loud solid-orange treatment:
 * those rows mean "the tenant's owner was paged" (needs-human, urgent caller
 * capture, notify_team) — the tenant is already handling it, so for the
 * platform admin they are awareness, not incidents. The outlined-orange
 * `high_load` style keeps them warm without screaming. Only `error` rows
 * (provisioning failures, AI task errors) are admin-actionable and stay loud.
 */
export function getLogBadgeVariant(
  status: string
): "high_load" | "error" | "success" | "pending" {
  if (status === "urgent_alert") return "high_load";
  if (status === "error") return "error";
  if (status === "success") return "success";
  return "pending";
}

/**
 * Admin-facing label for a coworker_logs status. "urgent alert" reads like a
 * platform incident on the admin dashboard; what the row actually records is
 * that the OWNER was alerted through their own channels.
 */
export function formatAlertStatusLabel(status: string): string {
  if (status === "urgent_alert") return "owner alerted";
  return formatAdminLabel(status);
}

/**
 * Badge variant for a `vps_inventory` row (fleet economics Phase B).
 * `available` is the state the pool exists for (an owned box waiting to be
 * adopted) so it gets the green; `retired` is a dead row kept for audit.
 */
export function getVpsInventoryBadgeVariant(state: string): "success" | "pending" | "neutral" {
  if (state === "available") return "success";
  if (state === "assigned") return "pending";
  return "neutral";
}

// ─── Recent Alerts card: payload-derived summaries ──────────────────────────

/** The slice of a coworker_logs row the summary helpers need. */
export type AlertLogLike = {
  task_type: string;
  status: string;
  log_payload: Record<string, unknown> | null;
};

/** Cap so one chatty payload can't blow up the card row. */
const ALERT_SUMMARY_MAX = 160;

/** Pull a non-empty trimmed string off the payload, else null. */
function payloadString(
  payload: Record<string, unknown> | null,
  key: string
): string | null {
  const raw = payload?.[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * "Who is this about?" — name + phone when both exist, either alone
 * otherwise. Covers every person-shaped key the coworker_logs writers use
 * (voice capture/notify_team, SMS notify_team, webchat/messenger captures,
 * and the edge alert helpers' contact_label).
 */
function personLabel(payload: Record<string, unknown> | null): string | null {
  const name =
    payloadString(payload, "callerName") ??
    payloadString(payload, "customerName") ??
    payloadString(payload, "visitorName") ??
    payloadString(payload, "contact_label");
  const phone =
    payloadString(payload, "callerPhone") ??
    payloadString(payload, "customerPhone") ??
    payloadString(payload, "contact_e164");
  if (name && phone) return `${name} (${phone})`;
  return name ?? phone;
}

/** First payload field that reads like "what happened". */
function detailText(payload: Record<string, unknown> | null): string | null {
  return (
    payloadString(payload, "summary") ??
    payloadString(payload, "message") ??
    payloadString(payload, "reason") ??
    payloadString(payload, "inbound_preview") ??
    payloadString(payload, "notes") ??
    payloadString(payload, "error")
  );
}

/**
 * Human one-liner for a fleet alert row, derived from `log_payload` — the
 * admin counterpart of the owner-facing summary builders (the notifications
 * Edge function and the dashboard activity feed's alertLabel). Before this,
 * the Recent Alerts card showed only the raw task_type ("Sms") and a
 * truncated business UUID, ignoring the story the payload already carries.
 */
export function adminAlertSummary(log: AlertLogLike): string {
  const payload = log.log_payload;
  const source = payloadString(payload, "source");
  const who = personLabel(payload);

  let text: string | null = null;
  if (source === "voice_tool_notify_team") {
    const message = payloadString(payload, "message");
    text = `Caller follow-up: ${who ?? "a caller"}${message ? ` — ${message}` : ""}`;
  } else if (source === "sms_tool_notify_team") {
    const message = payloadString(payload, "message");
    text = `Texter follow-up: ${who ?? "a texter"}${message ? ` — ${message}` : ""}`;
  } else if (source === "voice_tool_capture") {
    const why = payloadString(payload, "reason") ?? payloadString(payload, "notes");
    // Only high-urgency captures land as urgent_alert; routine caller-detail
    // captures are `success` rows (they reach the fleet ACTIVITY feed) and
    // must not be dressed up as urgent.
    const lead = log.status === "urgent_alert" ? "Urgent caller" : "Caller captured";
    text = `${lead}: ${who ?? "unknown caller"}${why ? ` — ${why}` : ""}`;
  } else if (log.task_type === "provisioning") {
    const phase = payloadString(payload, "phase");
    const message = payloadString(payload, "message");
    const verb =
      log.status === "error" ? "failed" : log.status === "success" ? "completed" : "update";
    text = `Provisioning ${verb}${phase ? ` at ${phase}` : ""}${message ? `: ${message}` : ""}`;
  } else {
    // Generic claw-gateway rows: surface the first useful payload string,
    // attributed to the person when the row carries one.
    const detail = detailText(payload);
    if (detail) {
      text = who ? `${who} — ${detail}` : detail;
    } else if (who) {
      text = `${formatAdminLabel(log.task_type)}: ${who}`;
    }
  }

  const fallback = `${formatAdminLabel(log.task_type)} ${formatAlertStatusLabel(log.status)}`;
  const line = text ?? fallback;
  return line.length > ALERT_SUMMARY_MAX ? `${line.slice(0, ALERT_SUMMARY_MAX - 1)}…` : line;
}

/** The two alert statuses the fleet feed carries, in filter-bar order. */
export const ALERT_FILTER_STATUSES = ["urgent_alert", "error"] as const;

/**
 * Parse the `status` URL param (comma-separated) into valid alert statuses,
 * dropping anything else and de-duplicating. Empty result = no filter.
 */
export function parseAlertStatusesParam(raw: string | undefined): string[] {
  if (!raw) return [];
  const valid = new Set<string>(ALERT_FILTER_STATUSES);
  return [...new Set(raw.split(","))].filter((s) => valid.has(s));
}

/**
 * The alert's page in the TENANT dashboard, or null when it has none.
 *
 * Every dispatched urgent alert lands on the owner's notifications page with
 * `payload.logId` = the coworker_logs id (stamped by the notifications Edge
 * function and the Node dispatch call sites alike), so `?logId=` deep-links
 * to the exact alert. `error` rows (provisioning/system failures) are never
 * dispatched owner-side — they have no tenant page, so callers keep the
 * admin business link.
 */
export function adminAlertHref(log: { id: string; status: string }): string | null {
  if (log.status !== "urgent_alert") return null;
  return `/dashboard/notifications?logId=${encodeURIComponent(log.id)}`;
}

export type AlertCounts = {
  /** Admin-actionable `error` rows in the fetched window. */
  errors: number;
  /** Rows from the trailing 24 hours. */
  last24h: number;
};

/**
 * Header counts for the Recent Alerts card. The old badge just echoed the
 * fetch limit (a red "10", always), which read as ten live incidents.
 */
export function summarizeAlertCounts(
  alerts: Array<{ status: string; created_at: string }>,
  now: Date = new Date()
): AlertCounts {
  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  let errors = 0;
  let last24h = 0;
  for (const a of alerts) {
    if (a.status === "error") errors++;
    const at = new Date(a.created_at).getTime();
    if (Number.isFinite(at) && at > dayAgo) last24h++;
  }
  return { errors, last24h };
}
