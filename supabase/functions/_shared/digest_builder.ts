/**
 * Pure digest-model builder for the notifications-digest Edge function.
 *
 * Why this exists: the original digest counted only `coworker_logs`, a table
 * that nothing but voice captures writes to — so every digest skipped with
 * "no_activity" while the business had chats, texts, and AiFlow runs. The
 * IO shell (../notifications-digest/index.ts) now aggregates the REAL
 * activity tables and hands plain rows to these helpers, which decide
 * whether anything happened and shape the email.
 *
 * Kept dependency-free (no supabase-js, no Deno APIs) so the module is unit
 * tested from vitest under the shared 100% coverage gate.
 */

export type DigestWindow = "daily" | "weekly";

export type DigestCallRow = {
  caller_e164: string | null;
  status: string;
  started_at: string;
};

export type DigestAiFlowRun = {
  flowName: string;
  status: string;
  created_at: string;
  /** ai_flow_runs.context — { vars: {...}, routing: {...}, ... } */
  context: Record<string, unknown>;
};

export type DigestCustomerRow = {
  display_name: string | null;
  customer_e164: string;
};

/** One customer texting conversation rolled up for the window. */
export type DigestSmsThread = {
  /** Customer-side phone (E.164) or short code. */
  counterpart: string;
  inbound: number;
  outbound: number;
  /** Most recent message timestamp in the thread (ISO). */
  lastAt: string;
};

export type DigestActivity = {
  /** Dashboard chat turns (dashboard_chat_jobs rows in window). */
  chatTurns: number;
  /** Inbound customer texts (sms_inbound_jobs rows in window). */
  smsInbound: number;
  /** Outbound texts (sum of daily_usage.sms_sent over the window dates). */
  smsOutbound: number;
  /**
   * Per-customer texting conversations in the window, so the dashboard can
   * deep-link each text event straight into its thread instead of the
   * messages index. Empty when no counterpart could be parsed (the event
   * builder then falls back to a single index roll-up).
   */
  smsThreads: DigestSmsThread[];
  calls: DigestCallRow[];
  aiFlowRuns: DigestAiFlowRun[];
  newCustomers: DigestCustomerRow[];
  /** coworker_logs rows with status=urgent_alert in window. */
  urgentAlerts: number;
  /** notifications rows with status=sent in window. */
  notificationsDelivered: number;
};

/** A single text message reduced to what the thread grouping needs. */
export type DigestSmsMessage = {
  counterpart: string;
  direction: "inbound" | "outbound";
  /** ISO timestamp. */
  at: string;
};

/**
 * A renderable customer phone: full E.164 (`+1…`) or a bare 3–8 digit short
 * code (lead sources like ReferralExchange text from short codes). Mirrors
 * `isRenderableSender` in src/lib/db/sms-history.ts; duplicated because the
 * Edge runtime cannot import from src/.
 */
export function isRenderableSmsSender(value: string): boolean {
  return value.startsWith("+") || /^\d{3,8}$/.test(value);
}

/**
 * Pluck the customer-side phone from a Telnyx inbound webhook envelope
 * (`{ data: { payload: { from } } }`). Returns null for unrecognized shapes.
 * Mirrors `customerE164FromPayload` in src/lib/db/sms-history.ts.
 */
export function smsCounterpartFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: { payload?: Record<string, unknown> } }).data;
  const inner = data?.payload;
  if (!inner) return null;
  const from = inner["from"] as { phone_number?: string } | string | undefined;
  if (typeof from === "string" && isRenderableSmsSender(from)) return from;
  if (
    from &&
    typeof from === "object" &&
    typeof from.phone_number === "string" &&
    isRenderableSmsSender(from.phone_number)
  ) {
    return from.phone_number;
  }
  return null;
}

/**
 * Group individual text messages into per-counterpart threads, most-recent
 * activity first. Pure so it can be unit-tested without the Edge runtime.
 */
export function groupSmsThreads(messages: DigestSmsMessage[]): DigestSmsThread[] {
  const byCounterpart = new Map<string, DigestSmsThread>();
  for (const m of messages) {
    const existing = byCounterpart.get(m.counterpart);
    if (existing) {
      if (m.direction === "inbound") existing.inbound += 1;
      else existing.outbound += 1;
      if (m.at > existing.lastAt) existing.lastAt = m.at;
    } else {
      byCounterpart.set(m.counterpart, {
        counterpart: m.counterpart,
        inbound: m.direction === "inbound" ? 1 : 0,
        outbound: m.direction === "outbound" ? 1 : 0,
        lastAt: m.at
      });
    }
  }
  return Array.from(byCounterpart.values()).sort((a, b) =>
    a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0
  );
}

export const AI_FLOW_RECAP_MAX_RUNS = 10;
const ACTIONS_TAKEN_MAX_CHARS = 220;

/**
 * One-line routing summary from a run's context.routing — who was offered
 * the lead and who (if anyone) claimed it. Mirrors
 * src/lib/ai-flows/run-stats.ts (the owner runs page), ported here because
 * the Edge runtime cannot import from src/.
 */
export function routingSummary(context: Record<string, unknown>): string | null {
  const routing = context.routing as Record<string, unknown> | undefined;
  if (!routing || typeof routing !== "object") return null;
  const tried = Array.isArray(routing.tried) ? routing.tried.length : 0;
  const hasCurrentOffer = typeof routing.offered === "string" && routing.offered !== "";
  const claimedName = typeof routing.claimed_name === "string" ? routing.claimed_name : "";
  const claimedBy = typeof routing.claimed_by === "string" ? routing.claimed_by : "";
  const claimed = claimedName || claimedBy;
  const offers = tried + (hasCurrentOffer || claimed ? 1 : 0);
  if (offers === 0) return null;
  const offersPart = `offered to ${offers} agent${offers === 1 ? "" : "s"}`;
  if (claimed) return `${offersPart} · claimed by ${claimed}`;
  if (hasCurrentOffer) return `${offersPart} · awaiting reply`;
  return `${offersPart} · no claim (owner fallback)`;
}

/** Well-known extracted-lead var names, in display order. */
const LEAD_VAR_KEYS = [
  ["lead_name", "name"],
  ["lead_phone", "phone"],
  ["lead_email", "email"]
] as const;

function extractLeadSummary(vars: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const aliases of LEAD_VAR_KEYS) {
    for (const key of aliases) {
      const value = vars[key];
      if (typeof value === "string" && value.trim()) {
        parts.push(value.trim());
        break;
      }
    }
  }
  return parts.length > 0 ? `lead: ${parts.join(", ")}` : null;
}

/**
 * One recap line per AiFlow run: name, status, routing ("offered to 3
 * agents · claimed by …"), extracted lead fields, and the run's
 * actions_taken log (capped so one chatty run can't flood the email).
 */
export function buildAiFlowRecapLine(run: DigestAiFlowRun): string {
  const vars = (run.context.vars ?? {}) as Record<string, unknown>;
  const segments: string[] = [`${run.flowName} — ${run.status}`];

  const routing = routingSummary(run.context);
  if (routing) segments.push(routing);

  const lead = extractLeadSummary(vars);
  if (lead) segments.push(lead);

  const actions = vars.actions_taken;
  if (typeof actions === "string" && actions.trim()) {
    const trimmed = actions.trim();
    segments.push(
      trimmed.length > ACTIONS_TAKEN_MAX_CHARS
        ? `${trimmed.slice(0, ACTIONS_TAKEN_MAX_CHARS - 1)}…`
        : trimmed
    );
  }

  return segments.join(" · ");
}

export function totalDigestEvents(a: DigestActivity): number {
  return (
    a.chatTurns +
    a.smsInbound +
    a.smsOutbound +
    a.calls.length +
    a.aiFlowRuns.length +
    a.newCustomers.length
  );
}

export function hasDigestActivity(a: DigestActivity): boolean {
  return totalDigestEvents(a) > 0;
}

export type DigestSection = { heading: string; lines: string[] };

/**
 * One clickable event for the dashboard notifications list. `href` is always
 * a dashboard-relative path (never absolute) so the client can render it as
 * an internal link without an allowlist.
 */
export type DigestEventLink = { label: string; href: string; at?: string };

/** Cap stored on the notifications row so one busy week can't bloat payload JSON. */
export const DIGEST_EVENT_LINKS_MAX = 30;

/**
 * Per-event deep links recorded on the digest's notifications row, so the
 * dashboard can expand a "Daily summary (5 events)" notification into the
 * actual events it counted, each linking to the relevant page.
 */
export function buildDigestEventLinks(activity: DigestActivity): DigestEventLink[] {
  // Non-text detail (calls, AiFlows, new customers) plus per-conversation text
  // deep links. These fill whatever budget is left after the guaranteed
  // summary events below.
  const detail: DigestEventLink[] = [];
  for (const c of activity.calls) {
    detail.push({
      label: `Call: ${c.caller_e164 ?? "unknown caller"} (${c.status})`,
      href: "/dashboard/calls",
      at: c.started_at
    });
  }
  for (const r of activity.aiFlowRuns) {
    detail.push({
      label: `AiFlow: ${r.flowName} (${r.status})`,
      href: "/dashboard/aiflows",
      at: r.created_at
    });
  }
  for (const cust of activity.newCustomers) {
    const who = cust.display_name
      ? `${cust.display_name} (${cust.customer_e164})`
      : cust.customer_e164;
    detail.push({
      label: `New customer: ${who}`,
      href: `/dashboard/customers/${encodeURIComponent(cust.customer_e164)}`
    });
  }
  // One clickable event per conversation, deep-linked to that thread so the
  // owner sees the actual texts (the "log") instead of the messages index.
  const threadLinks: DigestEventLink[] = activity.smsThreads.map((t) => ({
    label: `Texts with ${t.counterpart}: ${t.inbound} received, ${t.outbound} sent`,
    href: `/dashboard/messages/${encodeURIComponent(t.counterpart)}`,
    at: t.lastAt
  }));

  // Chat is always shown when present (reserved from the cap below).
  const chat: DigestEventLink[] = [];
  if (activity.chatTurns > 0) {
    chat.push({
      label: `Dashboard chat: ${activity.chatTurns} turn${activity.chatTurns === 1 ? "" : "s"}`,
      href: "/dashboard/chat"
    });
  }

  const hasTexts = activity.smsInbound > 0 || activity.smsOutbound > 0;
  const parsedInbound = activity.smsThreads.reduce((s, t) => s + t.inbound, 0);
  const parsedOutbound = activity.smsThreads.reduce((s, t) => s + t.outbound, 0);
  // True when some texts have no per-thread link (unparseable counterpart) and
  // would otherwise be invisible in the events list.
  const hasUnlinkedTexts =
    activity.smsInbound > parsedInbound || activity.smsOutbound > parsedOutbound;

  // Common case: every text maps to a thread AND everything fits under the cap
  // — emit the per-conversation deep links with no redundant index roll-up.
  if (
    hasTexts &&
    !hasUnlinkedTexts &&
    detail.length + threadLinks.length + chat.length <= DIGEST_EVENT_LINKS_MAX
  ) {
    return [...detail, ...threadLinks, ...chat];
  }

  if (!hasTexts) {
    // No texts: reserve chat from the cap, fill the rest with non-text detail.
    const budget = Math.max(0, DIGEST_EVENT_LINKS_MAX - chat.length);
    return [...detail.slice(0, budget), ...chat];
  }

  // Texts exist but can't all be shown individually (unparseable counterpart,
  // or more per-thread links than the cap allows). Guarantee an index roll-up
  // that covers EVERY text, reserve it and chat from the cap, then fill the
  // remaining budget with non-text + per-thread detail.
  const rollup: DigestEventLink = {
    label: `Texts: ${activity.smsInbound} received, ${activity.smsOutbound} sent`,
    href: "/dashboard/messages"
  };
  const budget = Math.max(0, DIGEST_EVENT_LINKS_MAX - chat.length - 1);
  const shownDetail = [...detail, ...threadLinks].slice(0, budget);
  return [...shownDetail, rollup, ...chat];
}

export type DigestEmailModel = {
  subject: string;
  intro: string;
  sections: DigestSection[];
  /** Short roll-up recorded on the notifications row. */
  activitySummary: string;
};

export function windowLabel(window: DigestWindow): { title: string; span: string } {
  return window === "weekly"
    ? { title: "Weekly summary", span: "the last 7 days" }
    : { title: "Daily summary", span: "the last 24 hours" };
}

export function buildDigestEmailModel(opts: {
  window: DigestWindow;
  businessName: string;
  activity: DigestActivity;
}): DigestEmailModel {
  const { window, businessName, activity } = opts;
  const { title, span } = windowLabel(window);
  const total = totalDigestEvents(activity);
  const sections: DigestSection[] = [];

  const convoLines: string[] = [];
  if (activity.chatTurns > 0) {
    convoLines.push(`Dashboard chat: ${activity.chatTurns} turn${activity.chatTurns === 1 ? "" : "s"}`);
  }
  if (activity.smsInbound > 0 || activity.smsOutbound > 0) {
    convoLines.push(
      `Texts: ${activity.smsInbound} received, ${activity.smsOutbound} sent`
    );
  }
  if (convoLines.length > 0) {
    sections.push({ heading: "Conversations", lines: convoLines });
  }

  if (activity.calls.length > 0) {
    const lines = activity.calls.slice(0, 10).map((c) => {
      const who = c.caller_e164 ?? "unknown caller";
      return `${who} — ${c.status}`;
    });
    if (activity.calls.length > 10) {
      lines.push(`…and ${activity.calls.length - 10} more`);
    }
    sections.push({
      heading: `Calls (${activity.calls.length})`,
      lines
    });
  }

  if (activity.aiFlowRuns.length > 0) {
    const shown = activity.aiFlowRuns.slice(0, AI_FLOW_RECAP_MAX_RUNS);
    const lines = shown.map(buildAiFlowRecapLine);
    if (activity.aiFlowRuns.length > AI_FLOW_RECAP_MAX_RUNS) {
      lines.push(`…and ${activity.aiFlowRuns.length - AI_FLOW_RECAP_MAX_RUNS} more runs`);
    }
    sections.push({
      heading: `AiFlow runs (${activity.aiFlowRuns.length})`,
      lines
    });
  }

  if (activity.newCustomers.length > 0) {
    const lines = activity.newCustomers.slice(0, 10).map((c) => {
      return c.display_name ? `${c.display_name} (${c.customer_e164})` : c.customer_e164;
    });
    if (activity.newCustomers.length > 10) {
      lines.push(`…and ${activity.newCustomers.length - 10} more`);
    }
    sections.push({
      heading: `New customers (${activity.newCustomers.length})`,
      lines
    });
  }

  const statusLines = [
    `Urgent alerts: ${activity.urgentAlerts}`,
    `Notifications delivered: ${activity.notificationsDelivered}`
  ];
  sections.push({ heading: "Status", lines: statusLines });

  const subject = `${title} — ${businessName} (${total} event${total === 1 ? "" : "s"})`;
  const intro = `Hi — here's what your AI Coworker handled over ${span}.`;
  const parts = [
    `${total} events`,
    activity.calls.length > 0 ? `${activity.calls.length} calls` : null,
    activity.smsInbound + activity.smsOutbound > 0
      ? `${activity.smsInbound + activity.smsOutbound} texts`
      : null,
    activity.aiFlowRuns.length > 0 ? `${activity.aiFlowRuns.length} AiFlow runs` : null,
    activity.urgentAlerts > 0 ? `${activity.urgentAlerts} urgent` : null
  ].filter((p): p is string => p !== null);
  const activitySummary = parts.join(", ");

  return { subject, intro, sections, activitySummary };
}
