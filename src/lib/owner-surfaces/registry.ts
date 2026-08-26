/**
 * One entry per coworker surface.
 *
 * A "surface" is a place the business's own people can reach their AI
 * coworker: dashboard chat, a text to the business line, an email thread,
 * Slack, WhatsApp. Each one needs the same handful of facts about itself,
 * and until this file existed those facts were spread across four modules
 * that could not see each other:
 *
 *   - the announce set and the owner-facing label in ai-flows/change-notice
 *   - the version-history label in ai-flows/version-history
 *   - the custom-table source map in dashboard-chat/action-tools
 *
 * Slack (PR #1382) had to touch all four by hand, and a surface that misses
 * one looks correct everywhere except the single place it was forgotten:
 * an owner gets "your coworker edited an automation" with no idea where it
 * happened, or a table's history says `ai_dashboard` for a change made by
 * text. Registering a surface here now supplies all of them at once, and
 * the registry test refuses a half-filled entry.
 *
 * Deliberately NOT in here: `dashboard` (the owner in the flow builder,
 * not the AI), `white_glove` (us, with the tenant already in the loop),
 * and `mcp` / `mcp_restore` (a connected app, which is a client rather
 * than a surface of ours). Those keep their own cases at the call sites,
 * because folding them in would make this list mean two different things.
 */

/** Surfaces the coworker can act from. `key` is the stable identifier. */
export type OwnerSurfaceKey = "dashboard" | "sms" | "email" | "slack" | "whatsapp";

export type OwnerSurfaceDefinition = {
  key: OwnerSurfaceKey;
  /** Settings-facing name, e.g. the staff-mode card's heading. */
  label: string;
  /** Settings-facing one-liner: what reaching the coworker here means. */
  description: string;
  /**
   * The `ai_flows.edit_source` stamped on an edit made here, which is what
   * the version history reads back. Always `ai_edit_<key>`.
   */
  flowEditSource: string;
  /** The `source` filed on a custom-table write made here. */
  customTableSource: string;
  /**
   * How the owner hears about a change made here, as it lands mid-sentence:
   * "Your coworker edited Lead followup <changeNoticeLabel>."
   */
  changeNoticeLabel: string;
  /** The full version-history row label for an edit made here. */
  historyLabel: string;
};

export const OWNER_SURFACES: readonly OwnerSurfaceDefinition[] = [
  {
    key: "dashboard",
    label: "Dashboard chat",
    description: "Your coworker on /dashboard/chat, where you are already signed in.",
    flowEditSource: "ai_edit_dashboard",
    customTableSource: "ai_dashboard",
    changeNoticeLabel: "in dashboard chat",
    historyLabel: "Edited by your coworker, in dashboard chat"
  },
  {
    key: "sms",
    label: "Texting your business number",
    description:
      "When you or a team member texts the business line, your coworker answers you as staff instead of running the lead-intake script.",
    flowEditSource: "ai_edit_sms",
    customTableSource: "ai_sms",
    changeNoticeLabel: "by text",
    historyLabel: "Edited by your coworker, by text"
  },
  {
    key: "email",
    label: "Email",
    description: "Threads your coworker handles from your connected mailbox.",
    flowEditSource: "ai_edit_email",
    customTableSource: "ai_email",
    changeNoticeLabel: "by email",
    historyLabel: "Edited by your coworker, by email"
  },
  {
    key: "slack",
    label: "Slack",
    description:
      "When you or a team member messages your coworker in your Slack workspace.",
    flowEditSource: "ai_edit_slack",
    customTableSource: "ai_slack",
    changeNoticeLabel: "in Slack",
    historyLabel: "Edited by your coworker, in Slack"
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    description:
      "When you or a team member messages your business's WhatsApp number, your coworker answers you as staff instead of treating you as a lead.",
    flowEditSource: "ai_edit_whatsapp",
    customTableSource: "ai_whatsapp",
    changeNoticeLabel: "on WhatsApp",
    historyLabel: "Edited by your coworker, on WhatsApp"
  }
];

const BY_KEY = new Map(OWNER_SURFACES.map((s) => [s.key as string, s]));
const BY_FLOW_EDIT_SOURCE = new Map(OWNER_SURFACES.map((s) => [s.flowEditSource, s]));

export function ownerSurfaceByKey(key: OwnerSurfaceKey): OwnerSurfaceDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * The surface behind an `ai_flows.edit_source` value, or null when the
 * source is not one of ours (the builder, white glove, MCP, a legacy row,
 * or an unstamped write). Null means "let the caller's own switch answer",
 * never "invent a surface".
 */
export function ownerSurfaceByFlowEditSource(
  source: string | null | undefined
): OwnerSurfaceDefinition | null {
  if (!source) return null;
  return BY_FLOW_EDIT_SOURCE.get(source) ?? null;
}
