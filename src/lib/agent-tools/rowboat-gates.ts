/**
 * The Rowboat tool-webhook DISPATCH ALLOWLIST: every tool name a per-tenant
 * Rowboat workflow may declare (vps/scripts/deploy-client.sh seed), mapped to
 * the Settings → Coworker tools toggle that gates it. /api/rowboat/tool-call
 * refuses any name not in TOOL_GATES (fail closed), so this map doubles as
 * the complete catalog of what the Rowboat-mediated coworkers can ever do.
 *
 * Lives in src/lib (not the route file) so the seed-parity CI test
 * (tests/agent-tool-seed-parity.test.ts) can assert registry ↔ seed ↔ gates
 * lockstep — a Next route module may only export HTTP handlers.
 */

import type { AgentKey } from "@/lib/agent-tools/registry";
import type { DocumentToolSurface } from "@/lib/documents/tool-handlers";

/**
 * toolName → the Settings → Coworker tools toggle that gates it, plus the
 * channel recorded on customer interactions and the stamp on pinned notes.
 * The `dashboard_`-prefixed names are the dashboard coworker's declarations
 * of the same underlying tools (see deploy-client.sh workflow seed).
 */
export const CUSTOMER_TOOL_SURFACES: Record<
  string,
  { agentKey: AgentKey; channel: "sms" | "dashboard"; stamp: string }
> = {
  customer_lookup_by_phone: { agentKey: "sms", channel: "sms", stamp: "text" },
  customer_set_display_name: { agentKey: "sms", channel: "sms", stamp: "text" },
  customer_append_pinned_note: { agentKey: "sms", channel: "sms", stamp: "text" },
  dashboard_customer_lookup_by_phone: { agentKey: "dashboard", channel: "dashboard", stamp: "dashboard" },
  dashboard_customer_set_display_name: { agentKey: "dashboard", channel: "dashboard", stamp: "dashboard" },
  dashboard_customer_append_pinned_note: { agentKey: "dashboard", channel: "dashboard", stamp: "dashboard" }
};

/** Strips the surface prefix: dashboard_customer_lookup_by_phone → customer_lookup_by_phone. */
export function baseToolKey(name: string): string {
  if (name.startsWith("dashboard_")) return name.slice("dashboard_".length);
  if (name.startsWith("webchat_")) return name.slice("webchat_".length);
  return name;
}

/** Which coworker surface a declared tool name belongs to (by its prefix). */
export function toolSurface(name: string): DocumentToolSurface {
  if (name.startsWith("dashboard_")) return "dashboard";
  if (name.startsWith("webchat_")) return "webchat";
  return "sms";
}

export const TOOL_GATES: Record<string, { agentKey: AgentKey; toolKey: string }> = {
  send_sms: { agentKey: "dashboard", toolKey: "send_sms" },
  send_whatsapp: { agentKey: "dashboard", toolKey: "send_whatsapp" },
  // Marketplace parity (all tools on all workers): the texting coworker
  // declares the bare names, the dashboard coworker its `dashboard_` twins —
  // same cores, separate Settings toggles.
  send_email: { agentKey: "sms", toolKey: "send_email" },
  // Texting-coworker escalation channel (same rationale as the voice twin in
  // /api/voice/tools/notify-team): without it the SMS assistant has NO path
  // to staff and can only promise follow-ups nobody hears about. Deliberately
  // NOT given a webchat_ twin (anonymous surface must not page the team).
  notify_team: { agentKey: "sms", toolKey: "notify_team" },
  generate_image: { agentKey: "sms", toolKey: "generate_image" },
  dashboard_generate_image: { agentKey: "dashboard", toolKey: "generate_image" },
  business_knowledge_lookup: { agentKey: "sms", toolKey: "business_knowledge_lookup" },
  calendar_find_slots: { agentKey: "sms", toolKey: "calendar_find_slots" },
  calendar_book_appointment: { agentKey: "sms", toolKey: "calendar_book_appointment" },
  // Appointment lifecycle beyond the initial booking (Truly Issue 4): a
  // reschedule updates the EXISTING provider event and a cancel deletes it —
  // never a second event plus a lingering original. No webchat twins: the
  // anonymous surface must not mutate the owner's calendar.
  calendar_reschedule_appointment: {
    agentKey: "sms",
    toolKey: "calendar_reschedule_appointment"
  },
  calendar_cancel_appointment: { agentKey: "sms", toolKey: "calendar_cancel_appointment" },
  dashboard_business_knowledge_lookup: {
    agentKey: "dashboard",
    toolKey: "business_knowledge_lookup"
  },
  dashboard_calendar_find_slots: { agentKey: "dashboard", toolKey: "calendar_find_slots" },
  dashboard_calendar_book_appointment: {
    agentKey: "dashboard",
    toolKey: "calendar_book_appointment"
  },
  dashboard_calendar_reschedule_appointment: {
    agentKey: "dashboard",
    toolKey: "calendar_reschedule_appointment"
  },
  dashboard_calendar_cancel_appointment: {
    agentKey: "dashboard",
    toolKey: "calendar_cancel_appointment"
  },
  // Website chat widget (anonymous internet surface): info + lead gen ONLY.
  // This is the COMPLETE `webchat_*` allowlist — the WebchatCoworker agent
  // seed declares exactly these names, and because TOOL_GATES doubles as the
  // dispatch allowlist, no webchat-prefixed name can ever resolve to SMS,
  // email, call, or image-generation fulfilment. Keep it that way: when new
  // side-effect tools land on other surfaces, do NOT mint webchat_ twins.
  webchat_business_knowledge_lookup: {
    agentKey: "webchat",
    toolKey: "business_knowledge_lookup"
  },
  webchat_capture_lead: { agentKey: "webchat", toolKey: "capture_lead" },
  webchat_calendar_find_slots: { agentKey: "webchat", toolKey: "calendar_find_slots" },
  webchat_calendar_book_appointment: {
    agentKey: "webchat",
    toolKey: "calendar_book_appointment"
  },
  // Business documents: share exists on every Rowboat surface (webchat's
  // twin is inline-only — the handler never sends SMS/email for webchat);
  // list/update/set-expiration are dashboard-only by design (customers must
  // never mutate business knowledge), so no sms/webchat names exist for
  // them and unknown names fail closed.
  document_share: { agentKey: "sms", toolKey: "document_share" },
  dashboard_document_share: { agentKey: "dashboard", toolKey: "document_share" },
  webchat_document_share: { agentKey: "webchat", toolKey: "document_share" },
  dashboard_document_list: { agentKey: "dashboard", toolKey: "document_list" },
  dashboard_document_update: { agentKey: "dashboard", toolKey: "document_update" },
  dashboard_document_set_expiration: {
    agentKey: "dashboard",
    toolKey: "document_set_expiration"
  },
  dashboard_document_request_signature: {
    agentKey: "dashboard",
    toolKey: "document_request_signature"
  },
  // Run-automations parity with the inline dashboard path (both names share
  // the single `run_aiflow` Settings toggle, mirroring the inline gating).
  // Dashboard-only by design: customers must never enumerate or start the
  // owner's automations, so no webchat twins exist and the bare names
  // fail closed.
  dashboard_list_aiflows: { agentKey: "dashboard", toolKey: "run_aiflow" },
  dashboard_run_aiflow: { agentKey: "dashboard", toolKey: "run_aiflow" },
  // The ONE narrow exception to the rule above, double-gated: the texting
  // coworker may enroll the CURRENT texter into a flow the owner explicitly
  // flagged `options.agentInvocable` (per-flow opt-in, default off) — it can
  // never enumerate, start, or even see any other automation, and a live
  // enrollment is never restarted (loop guard in the core). Deliberately NO
  // webchat twin: the anonymous surface must not start automations at all.
  start_aiflow_for_contact: { agentKey: "sms", toolKey: "start_aiflow_for_contact" },
  // Notification toggles from the texting surface (KYP, Jul 20 2026: "let
  // me know when clients text back"). ENABLE-ONLY at dispatch — the SMS
  // Coworker serves customers and staff alike, so a prompt-injected
  // customer must never be able to SILENCE the owner's alerts; the worst
  // outcome is extra noise. Full control lives on identity-verified
  // surfaces (dashboard inline chat, MCP). No webchat or dashboard_ twin.
  update_notification_preferences: {
    agentKey: "sms",
    toolKey: "update_notification_preferences"
  },
  ...Object.fromEntries(
    Object.entries(CUSTOMER_TOOL_SURFACES).map(([name, surface]) => [
      name,
      { agentKey: surface.agentKey, toolKey: baseToolKey(name) }
    ])
  )
};
