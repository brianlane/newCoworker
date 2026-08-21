import type { OutboundLogSource } from "@/lib/db/sms-history";

/**
 * Sender label for an outbound text, keyed by `sms_outbound_log.source`.
 * Shared by the thread page bubbles and the contact profile's SMS history
 * card so the two surfaces attribute sends identically. (The card used to
 * collapse every source to "AiFlow", so an owner-typed reply rendered as a
 * flow send on the profile while the thread correctly said "You".)
 *
 * Pure data (no "use client"), importable from server components, mirrors
 * `activity-badge.ts`. Keyed by the full union so adding a new source to
 * `OutboundLogSource` without choosing a label is a compile error.
 */
export const SMS_SOURCE_LABEL: Record<OutboundLogSource, string> = {
  ai_flow: "AiFlow",
  agent_offer: "AiFlow · team offer",
  owner_notify: "AiFlow · notification",
  owner_manual: "You",
  owner_scheduled: "You · scheduled",
  api: "Assistant",
  voice_follow_up: "Assistant · call follow-up",
  mcp: "Claude connector",
  mcp_chatgpt: "ChatGPT app",
  dashboard_chat: "Assistant",
  owner_alert: "Coworker · urgent alert"
};

/**
 * Label for a message given its outbound-log source. `undefined`/unknown
 * fall back to "Assistant": conversational replies synthesized from
 * `sms_inbound_jobs` carry no source, and a source value newer than this
 * build must still render something sensible.
 */
export function smsSourceLabel(source: string | null | undefined): string {
  if (!source) return "Assistant";
  return SMS_SOURCE_LABEL[source as OutboundLogSource] ?? "Assistant";
}
