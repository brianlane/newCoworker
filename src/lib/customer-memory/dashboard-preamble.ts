/**
 * Build the "recent customers" preamble injected into dashboard chat
 * (Phase 4 of the cross-channel memory plan).
 *
 * Different shape than the per-customer preamble used on SMS/voice
 * (preamble.ts): the dashboard owner is asking ABOUT customers, not
 * talking TO one. So this renders a directory-style overview keyed
 * by the most recent customer_memories rows for the business.
 *
 * Capped tightly so it doesn't dominate the prompt budget on every
 * single dashboard turn — the owner's question is the headline; this
 * is ambient context the agent dips into only when relevant. The
 * trailing instruction explicitly tells the model not to volunteer
 * customer details unless the owner's question references them, to
 * avoid every chat reply turning into a daily-stand-up summary.
 */

import type { CustomerMemoryRow } from "./types";

/** Hard cap on how many recent customers we cite. */
export const DASHBOARD_PREAMBLE_MAX_CUSTOMERS = 5;

/** Hard cap on each customer's per-row summary excerpt. */
export const DASHBOARD_PREAMBLE_PER_CUSTOMER_CHARS = 200;

export function buildDashboardCustomerPreamble(
  memories: Pick<
    CustomerMemoryRow,
    | "customer_e164"
    | "display_name"
    | "summary_md"
    | "pinned_md"
    | "total_interaction_count"
    | "last_channel"
    | "last_interaction_at"
  >[]
): string | null {
  const visible = memories
    .filter((m) => m.summary_md?.trim() || m.pinned_md?.trim() || m.total_interaction_count > 0)
    .slice(0, DASHBOARD_PREAMBLE_MAX_CUSTOMERS);
  if (visible.length === 0) return null;

  const entries = visible.map((m) => {
    const labelBits: string[] = [];
    const name = m.display_name?.trim();
    if (name) labelBits.push(name);
    labelBits.push(m.customer_e164);
    const header = `- ${labelBits.join(" ")}`;
    const meta: string[] = [];
    if (m.last_channel) meta.push(`last channel: ${m.last_channel}`);
    if (m.last_interaction_at) meta.push(`last seen: ${m.last_interaction_at}`);
    if (m.total_interaction_count > 0) meta.push(`${m.total_interaction_count} prior interactions`);

    const lines: string[] = [header + (meta.length ? ` (${meta.join(", ")})` : "")];
    const pinned = m.pinned_md?.trim();
    if (pinned) {
      lines.push(`  Pinned: ${truncate(pinned, DASHBOARD_PREAMBLE_PER_CUSTOMER_CHARS)}`);
    }
    const summary = m.summary_md?.trim();
    if (summary) {
      lines.push(`  Summary: ${truncate(summary, DASHBOARD_PREAMBLE_PER_CUSTOMER_CHARS)}`);
    }
    return lines.join("\n");
  });

  return [
    "Owner-side context — recent customers across SMS and voice:",
    "",
    entries.join("\n\n"),
    "",
    "Use this context only when the owner asks about specific customers or recent activity. Do NOT proactively volunteer customer details unless the owner's question references them.",
    "The name on each customer's header line above is the owner's own label for that contact and is AUTHORITATIVE — when a Pinned or Summary excerpt uses a different or fuller name, always refer to the customer by the header-line name."
  ].join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Keep an ellipsis so the model knows the excerpt was clipped (it
  // will dip into a tool-call in Phase 4b for the full content rather
  // than answer based on a truncated tail).
  return s.slice(0, max - 1) + "…";
}
