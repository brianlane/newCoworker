/**
 * Canonical inventory of what MOVES to an opted-in enterprise tenant's VPS
 * versus what STAYS in central Supabase.
 *
 * This list is the single source of truth for the residency program: the
 * DDL generator (debug/generate-residency-ddl.ts), the data-API contract
 * (src/lib/residency/contract.ts), the dual-write layer, and the eventual
 * Phase 4 purge all key off it. Add a table here only when every one of its
 * readers/writers can reach the tenant's data API (dashboard `src/lib/db/*`
 * modules and the Edge `_shared` helpers).
 *
 * Placement decisions that are NOT obvious from the names:
 *
 * - `sms_opt_outs` STAYS CENTRAL. It is tenant content in spirit, but it
 *   gates every outbound send on the compliance-critical Telnyx webhook
 *   path (STOP handling must keep working even when the tenant's box is
 *   down or mid-migration). Losing availability there is a legal risk, not
 *   a UX bug, so the compliance ledger keeps central availability.
 *
 * - Engine/job tables (`ai_flow_runs`, `sms_inbound_jobs`,
 *   `dashboard_chat_jobs`, `telnyx_webhook_events`) STAY CENTRAL: they are
 *   written by external webhooks and drained by Supabase Edge workers.
 *   Moving them means moving the engine — out of scope. Their
 *   customer-visible OUTPUT lands in the moved content tables.
 *
 * - Billing/metering/provisioning tables STAY CENTRAL by definition
 *   (cross-tenant control plane).
 */

/**
 * Tenant customer content that moves to the VPS datastore for opted-in
 * enterprise tenants. Every table here is single-tenant-scoped by a
 * `business_id` column and is only read/written by platform code (no
 * external webhook writes directly into any of them).
 */
export const RESIDENCY_MOVED_TABLES = [
  // Contacts + identity side tables
  "contacts",
  "contact_overrides",
  // Customer AI profile/memory
  "customer_profiles",
  "customer_memories",
  // Owner dashboard chat
  "dashboard_chat_threads",
  "dashboard_chat_messages",
  "dashboard_chat_activity",
  // Email content
  "email_log",
  // Voice content
  "voice_call_transcripts",
  "voice_call_transcript_turns",
  "voice_outbound_dial_log",
  // SMS content
  "sms_outbound_log",
  "sms_rowboat_threads",
  "sms_owner_reply_prompts",
  "scheduled_sms",
  // Notifications shown to the owner
  "notifications",
  // Tenant-authored automation definitions + their browse memory
  "ai_flows",
  "aiflow_url_memory"
] as const;

export type ResidencyMovedTable = (typeof RESIDENCY_MOVED_TABLES)[number];

export function isResidencyMovedTable(name: string): name is ResidencyMovedTable {
  return (RESIDENCY_MOVED_TABLES as readonly string[]).includes(name);
}
