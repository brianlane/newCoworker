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
 *
 * - `customer_profiles` STAYS CENTRAL despite the name: it is the
 *   PLATFORM's abuse/billing identity of the paying business owner
 *   (lifetime refund-once, subscription caps, Stripe ids) — cross-tenant
 *   control plane, not the tenant's customer data. The tenant's customer
 *   memory lives in `contacts`.
 *
 * - `sms_links` (tracked short links) STAYS CENTRAL like `sms_opt_outs`:
 *   the public /s/<code> redirect must keep resolving links embedded in
 *   texts customers already received, even when the tenant's box is down
 *   or mid-migration. The PII it carries (recipient number + original URL)
 *   is covered by retention pruning and end-user erasure
 *   (src/lib/privacy/{retention,deletion}.ts), both central-only for it.
 */

/**
 * Tenant customer content that moves to the VPS datastore for opted-in
 * enterprise tenants. Every table here is single-tenant-scoped by a
 * `business_id` column and is only read/written by platform code (no
 * external webhook writes directly into any of them).
 */
export const RESIDENCY_MOVED_TABLES = [
  // Unified contact directory + the AI's cross-channel memory. Absorbed the
  // former `customer_memories` (renamed) and `contact_overrides` (folded in,
  // dropped) in 20260704000000_contacts_unify.sql; `customer_memories`
  // survives only as a backward-compat VIEW over this table, and views are
  // not replicated (the data-api serves the base table).
  "contacts",
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

/**
 * Primary-key columns per moved table. The replication layer keys on these:
 * journal 'upsert' rows become PK-conflict upserts on the box (last writer
 * wins per row, applied in seq order) and 'delete' rows become PK-filtered
 * deletes. Two tables have composite natural keys; everything else is `id`.
 * Keep in lockstep with vps/data-api/schema.sql (generated from the live
 * central schema).
 */
export const RESIDENCY_TABLE_PRIMARY_KEYS: Record<ResidencyMovedTable, readonly string[]> = {
  contacts: ["id"],
  dashboard_chat_threads: ["id"],
  dashboard_chat_messages: ["id"],
  dashboard_chat_activity: ["business_id"],
  email_log: ["id"],
  voice_call_transcripts: ["id"],
  voice_call_transcript_turns: ["id"],
  voice_outbound_dial_log: ["id"],
  sms_outbound_log: ["id"],
  sms_rowboat_threads: ["business_id", "customer_e164"],
  sms_owner_reply_prompts: ["id"],
  scheduled_sms: ["id"],
  notifications: ["id"],
  ai_flows: ["id"],
  aiflow_url_memory: ["business_id", "memory_key"]
};
