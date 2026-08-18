import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Privacy coverage guard: every table that carries a business_id column must
 * be an explicit decision. Either the erasure/retention modules handle it
 * (its quoted name appears in src/lib/privacy/deletion.ts or retention.ts),
 * or it is listed below with the reason it is out of scope. A new content
 * table that ships without a decision fails this test, which is the point:
 * the public data-deletion page promises coverage of every content store,
 * and that promise must not silently rot as the schema grows (the way
 * webchat and messenger did before 2026-08).
 *
 * To fix a failure: add the table to deleteEndUserData/pruneExpiredContent
 * with an identifier-keyed delete, or add one line here with an honest
 * reason. Do NOT add a table here just to silence the test: "holds person
 * data but covering it is annoying" is not a reason.
 */

const ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

/** Same identifier grammar as tests/migration-grants.test.ts. */
const IDENT = String.raw`"?([a-z_][a-z0-9_]*)"?`;
const QUALIFIED = String.raw`(?:"?public"?\.)?${IDENT}`;
const CREATE_TABLE_RE = new RegExp(
  String.raw`\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?${QUALIFIED}\s*\(([\s\S]*?)\n\);`,
  "gi"
);

function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** Tables with a business_id column, keyed to the migration that created them. */
function businessScopedTables(): Map<string, string> {
  const tables = new Map<string, string>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = stripLineComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    for (const m of sql.matchAll(CREATE_TABLE_RE)) {
      const name = m[1].toLowerCase();
      if (/\bbusiness_id\b/.test(m[2]) && !tables.has(name)) tables.set(name, file);
    }
  }
  return tables;
}

/**
 * Tables whose CREATE TABLE name was later renamed. The guard follows the
 * rename and requires the CURRENT name to be handled by the privacy
 * modules, so a rename can never mask dropped coverage of the live table
 * (Bugbot finding, 2026-08-01: an exemption entry alone would keep CI green
 * even if deleteEndUserData stopped touching contacts).
 */
const RENAMED: Record<string, string> = {
  // 20260704000000_contacts_unify.sql
  customer_memories: "contacts"
};

/**
 * Out-of-scope registry. Grouped by why; each entry is one deliberate
 * decision with its reason.
 */
const EXEMPT: Record<string, string> = {
  // Covered through another table.
  webchat_messages: "FK cascade from webchat_sessions (covered)",
  webchat_jobs: "FK cascade from webchat_sessions (covered)",
  messenger_jobs: "FK cascade from messenger_conversations (covered)",
  ai_flow_run_steps: "FK cascade from ai_flow_runs (covered)",
  sms_link_clicks: "FK cascade from sms_links (covered); rows carry no person columns",
  sms_destination_events:
    "destination-gate counters (business_id + ISO country + timestamp, no person columns); powers the velocity brake and first-country alert, cascades with the business",

  // Deliberate keeps: suppression must survive erasure.
  sms_opt_outs:
    "STOP suppression must survive erasure; deleting the row would let the platform text the person again",
  terms_acceptances:
    "the tenant's own clickwrap evidence (account scope, not end-customer data); like signed signature requests, acceptance proof must survive erasure",
  phi_access_log:
    "HIPAA 164.312(b) audit trail: WHO viewed a record, which is evidence about workforce access rather than customer content. Append-only by grant (no update/delete is granted at all, so a sweep could not trim it), retained 6 years per 164.316(b)(2). Erasing it on request would destroy the proof that the erasure duty was met",

  // Tenant/platform configuration: no end-customer person rows.
  agent_tool_settings: "per-tenant tool toggles",
  ai_flow_definition_versions:
    "prior versions of the same owner-authored flow definitions ai_flows is exempted for; FK cascades from ai_flows",
  ai_flow_pending_edits:
    "AI edits compiled but not yet applied: owner-authored flow definitions awaiting a yes, same content class as ai_flows; rows are single-use and expire",
  ai_flow_library_downloads: "library install ledger",
  ai_flows: "flow definitions authored by the owner",
  aiflow_url_memory: "flow URL fetch cache keyed by URL",
  api_keys: "tenant API credentials",
  acuity_appointment_state: "provider appointment ids + timestamps only",
  booking_busy_cache: "provider free/busy block cache, no identifiers",
  booking_meeting_types: "owner scheduling configuration",
  booking_pages: "owner booking-page configuration (questions, not answers)",
  business_agents: "owner agent definitions",
  business_channel_settings: "channel configuration",
  business_configs: "tenant configuration",
  business_services: "service catalog",
  business_telnyx_settings: "telephony configuration",
  business_voice_quota_lock: "advisory lock row",
  calendar_feed_tokens: "capability tokens; the ICS feed deliberately exposes display names only",
  calendly_webhook_subscriptions: "webhook plumbing",
  chat_widget_settings: "widget configuration",
  custom_integrations: "integration configuration",
  notification_preferences: "owner notification settings",
  outreach_settings: "outreach configuration (postal address is the tenant's own)",
  pipeline_stages: "pipeline configuration",
  pipelines: "pipeline configuration",
  sms_templates: "owner message templates",
  telnyx_voice_routes: "call routing configuration",
  voice_caller_transfer_rules: "routing rules keyed to the business's own targets",
  voice_expected_transfers: "one row per business; to_e164 is the business's own transfer target",
  voice_handoff_chains: "routing chain configuration (team numbers)",
  webhook_subscriptions: "webhook plumbing",

  // Owner/team/account scope: the business's own people and work products.
  // Free-text mentions of a customer inside owner content are not records
  // keyed to the person (same boundary the policy draws for documents).
  agent_runs: "owner-initiated agent work products",
  ai_flow_team_members: "the business's own roster",
  business_documents: "owner document store",
  business_members: "team membership",
  contact_segments: "saved list definitions (name + filter), not person rows",
  dashboard_chat_activity: "owner dashboard chat",
  dashboard_chat_jobs: "owner dashboard chat",
  dashboard_chat_threads: "owner dashboard chat",
  email_campaigns: "owner-authored campaign content; recipients are covered separately",
  email_coworker_seen: "message-id dedupe set; no person columns",
  employee_time_off: "the business's own staff",
  enterprise_deals: "deal records about the tenant",
  onboarding_drafts: "the buyer's own onboarding answers (account scope)",
  social_posts: "owner marketing content",
  sessions: "legacy channel session ledger: channel + timestamps only",
  tenant_mailboxes: "the tenant's own mailbox provisioning",
  white_glove_intakes: "the buyer's own intake (account scope)",
  white_glove_offers: "offer records addressed to the buyer (account scope)",

  // Tenant connection/credential material for services the owner linked.
  acuity_connections: "tenant credentials",
  caldav_connections: "tenant credentials",
  calendly_connections: "tenant credentials",
  integrations: "tenant integration state",
  meta_connections: "tenant Page tokens",
  slack_connections: "tenant OAuth grants (workspace bot token, no end-customer data)",
  slack_conversations:
    "internal team chat threads (no end-customer identifiers to erase by); business-scoped, removed with the business cascade",
  slack_messages:
    "internal team chat content; business-scoped, removed with the business cascade",
  slack_jobs: "reply-queue bookkeeping for internal team chat; cascades with the conversation",
  vagaro_connections: "tenant credentials",
  whatsapp_connections: "the tenant's own WABA connection",
  workspace_oauth_connections: "tenant OAuth grants",
  zoom_connections: "tenant OAuth grants",
  zoom_transcript_imports: "import ledger keyed by meeting id; content lands in business_documents",

  // Billing, metering, and aggregates: no end-customer identifiers.
  analytics_daily_snapshots: "aggregates",
  chat_spend_credit_grants: "billing",
  chat_spend_velocity_alerts: "billing telemetry",
  chat_spend_velocity_snapshots: "billing telemetry",
  daily_usage: "usage counters",
  gemini_spend_events: "spend ledger",
  owner_chat_model_spend: "spend ledger",
  owner_chat_spend_reservations: "spend ledger",
  priority_support_subscriptions:
    "the tenant's own $400/month priority support subscription: business_id, Stripe subscription/customer/session ids, status, and period dates. No end-customer identifiers. `created_by` is the OWNER or the ADMIN who started it, i.e. account-scope evidence of who authorized the charge, the same boundary usage_pack_auto_reload_cards draws. Cascades with the business.",
  promotion_redemptions: "billing",
  sms_bonus_grants: "billing",
  sms_outbound_rate: "rate limiting state",
  subscriptions: "billing",
  telnyx_cost_daily: "cost aggregates",
  stripe_fee_monthly:
    "Stripe fee aggregates per month and tenant (gross/fee/net cents, charge counts); operator cost telemetry with no end-customer columns, and business_id detaches via on delete set null so the fleet cost history survives a tenant deletion",
  usage_cap_alerts: "alert dedupe state",
  voice_capacity_alerts:
    "Telnyx capacity alert dedupe + audit (business_id, flow id, carrier error metadata; no person columns); business_id detaches via on delete set null so the fleet-wide audit trail survives a tenant deletion",
  usage_pack_auto_reload_rules: "the tenant's own top-up thresholds and spend caps",
  usage_pack_auto_reload_events:
    "auto-reload charge ledger (amounts, Stripe intent ids); billing evidence for an unattended charge, no end-customer identifiers",
  usage_pack_auto_reload_cards:
    "the tenant's own card authorization for auto-charging: a Stripe payment method id plus the consent record (who, when, which copy version). Deliberately survives erasure like terms_acceptances, because it is the evidence we produce if the tenant disputes a charge we made. Holds no end-customer data, and the card itself lives at Stripe.",
  voice_billing_period_usage: "usage counters",
  voice_bonus_grants: "billing",
  voice_forwarded_call_meter: "metering",
  voice_reservations: "concurrency accounting",
  voice_settlements: "billing",

  // Infrastructure, provisioning, and ops.
  applied_oneshots: "ops ledger",
  data_backups: "backup metadata",
  number_port_requests: "the tenant's own number porting",
  provisioning_jobs: "provisioning state",
  residency_backup_keys: "backup key escrow",
  residency_write_journal:
    "replication transit journal; rows delete on confirmation, and journaled deletes propagate erasure to the box",
  system_logs: "operational diagnostics, not person-keyed",
  voice_active_sessions: "ephemeral live-call engine state, cleared at call teardown",
  voice_transfer_notifications: "dedupe key + outcome only",
  vps_gateway_tokens: "infrastructure",
  vps_migration_locks: "infrastructure",
  vps_posture_reports: "infrastructure",
  vps_ssh_keys: "infrastructure"
};

describe("privacy coverage guard", () => {
  const tables = businessScopedTables();
  const deletionSrc = readFileSync(join(ROOT, "src", "lib", "privacy", "deletion.ts"), "utf8");
  const retentionSrc = readFileSync(join(ROOT, "src", "lib", "privacy", "retention.ts"), "utf8");
  const handled = (name: string): boolean =>
    deletionSrc.includes(`"${name}"`) || retentionSrc.includes(`"${name}"`);

  it("every business-scoped table is either privacy-handled or explicitly exempted", () => {
    const undecided = [...tables.keys()]
      .filter((name) => {
        const effective = RENAMED[name] ?? name;
        return !handled(effective) && !(name in EXEMPT);
      })
      .sort()
      .map((name) => `${name} (created in ${tables.get(name)})`);
    expect(
      undecided,
      "These business-scoped tables are in neither src/lib/privacy/deletion.ts, " +
        "src/lib/privacy/retention.ts, nor the EXEMPT registry in this test. " +
        "Decide: add erasure/retention coverage, or add an exemption WITH an honest reason."
    ).toEqual([]);
  });

  it("exempt entries are real tables (no stale registry rows)", () => {
    const stale = Object.keys(EXEMPT)
      .filter((name) => !tables.has(name))
      .sort();
    expect(
      stale,
      "These EXEMPT entries no longer match any business-scoped table; remove them."
    ).toEqual([]);
  });

  it("renamed tables stay covered under their LIVE name", () => {
    for (const [oldName, newName] of Object.entries(RENAMED)) {
      expect(tables.has(oldName), `expected ${oldName} in the migration scan`).toBe(true);
      expect(
        handled(newName),
        `${oldName} was renamed to ${newName}; the privacy modules must handle ${newName}`
      ).toBe(true);
      expect(
        oldName in EXEMPT,
        `${oldName} must not ALSO be exempted; the rename mapping is its decision`
      ).toBe(false);
    }
  });

  it("exempt entries are not simultaneously handled (keep the registry honest)", () => {
    const overlap = Object.keys(EXEMPT)
      .filter((name) => handled(name))
      .sort();
    expect(
      overlap,
      "These tables are both privacy-handled and exempted; delete the stale exemption."
    ).toEqual([]);
  });

  it("the guard itself sees a plausible schema (sanity floor)", () => {
    // If the migration parser ever breaks, the two lists above would go
    // vacuously green. Pin a floor well below reality (127 as of 2026-08)
    // and a few known-covered names.
    expect(tables.size).toBeGreaterThan(100);
    // Note: contacts itself never had a CREATE TABLE (it is the renamed
    // customer_memories), so the scan sees the original name.
    for (const known of ["customer_memories", "email_log", "webchat_sessions", "memory_entities"]) {
      expect(tables.has(known), `expected ${known} in the scan`).toBe(true);
    }
  });
});
