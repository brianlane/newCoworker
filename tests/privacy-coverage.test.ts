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
/**
 * Name-only forms, for the create/drop ledger below.
 *
 * The question the ledger answers is "does PostgREST still resolve this
 * name?", which is NOT the same as "was a table dropped". Four statements
 * move a name in or out of the schema cache and all four are matched:
 * CREATE TABLE, DROP TABLE, ALTER TABLE ... RENAME TO (the old name stops
 * resolving and the new one starts), and the VIEW pair (a compat view over a
 * renamed table keeps the old name resolving, which is exactly what
 * contacts_unify did for customer_memories).
 */
const CREATE_NAME_RE = new RegExp(
  String.raw`\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?${QUALIFIED}`,
  "gi"
);
/**
 * Postgres accepts a comma list, so capture everything up to the terminator
 * and split it. Matching one name would silently ledger only the first, and
 * a missed drop is exactly the failure this guard exists to catch.
 */
const DROP_TABLE_RE = /\bdrop\s+table\s+(?:if\s+exists\s+)?([^;]+?)(?:\s+(?:cascade|restrict))?\s*;/gi;
const RENAME_TABLE_RE = new RegExp(
  String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QUALIFIED}\s+rename\s+to\s+${QUALIFIED}`,
  "gi"
);
const CREATE_VIEW_RE = new RegExp(
  String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?${QUALIFIED}`,
  "gi"
);
const DROP_VIEW_RE = /\bdrop\s+(?:materialized\s+)?view\s+(?:if\s+exists\s+)?([^;]+?)(?:\s+(?:cascade|restrict))?\s*;/gi;

/** Strip a comma list of possibly schema-qualified names down to bare names. */
function splitNameList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim().replace(/^"?public"?\./i, "").replace(/"/g, "").toLowerCase())
    .filter((part) => /^[a-z_][a-z0-9_]*$/.test(part));
}

/**
 * Blank out SQL comments so DDL prose cannot register a phantom create or
 * drop, WITHOUT touching string literals.
 *
 * The literal-awareness is not academic. 20260711002041_spend_velocity_alerts
 * carries a comment string ending in a slash-star at :38 (an /api/admin route
 * glob) and an every-ten-minutes cron literal at :161 that begins with a
 * star-slash. A naive block-comment regex reads the first as an opening
 * delimiter and the second as its close, silently eating the 120 lines between
 * them, two CREATE TABLEs included. That failure is why this scanner tracks
 * single-quoted strings and dollar-quoted bodies and only recognises a comment
 * outside them.
 *
 * Comments are replaced with spaces rather than removed, so every surviving
 * statement keeps its original offset and the in-file ordering the ledger
 * relies on stays exact.
 */
function stripSqlComments(sql: string): string {
  const out = sql.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") { i++; break; }
        else i++;
      }
      continue;
    }
    const dollar = /^\$[a-z_]*\$/i.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      continue;
    }
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      const stop = nl === -1 ? sql.length : nl;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === "/*") { depth++; j += 2; }
        else if (sql.slice(j, j + 2) === "*/") { depth--; j += 2; }
        else j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Tables with a business_id column, keyed to the migration that created them. */
function businessScopedTables(): Map<string, string> {
  const tables = new Map<string, string>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    for (const m of sql.matchAll(CREATE_TABLE_RE)) {
      const name = m[1].toLowerCase();
      if (/\bbusiness_id\b/.test(m[2]) && !tables.has(name)) tables.set(name, file);
    }
  }
  return tables;
}

/**
 * Names the migration history stops resolving, keyed to the migration that
 * stopped them. Replaying the files in version order is the only honest way
 * to answer "does PostgREST still resolve this name?": a drop can be followed
 * by a recreate, a rename retires one name and introduces another, and a
 * compat VIEW can keep a renamed-away name resolving. Only the last statement
 * wins, so the ledger has to see all of them.
 *
 * contacts_unify exercises three of the four in one file: it renames
 * customer_memories to contacts, drops contact_overrides, and then creates a
 * customer_memories view over contacts. The correct answer is that only
 * contact_overrides is unresolvable, and the replay produces exactly that.
 */
function unresolvableNames(): Map<string, string> {
  const dropped = new Map<string, string>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    // Within one file, order still matters (contacts_unify renames one table,
    // drops another, and creates a compat view over the renamed one), so walk
    // every statement kind in source order.
    const events: Array<{ at: number; name: string; drop: boolean }> = [];
    const add = (at: number, names: string[], drop: boolean): void => {
      for (const name of names) events.push({ at, name, drop });
    };
    for (const m of sql.matchAll(CREATE_NAME_RE)) {
      add(m.index ?? 0, [m[1].toLowerCase()], false);
    }
    for (const m of sql.matchAll(CREATE_VIEW_RE)) {
      add(m.index ?? 0, [m[1].toLowerCase()], false);
    }
    for (const m of sql.matchAll(DROP_TABLE_RE)) {
      add(m.index ?? 0, splitNameList(m[1]), true);
    }
    for (const m of sql.matchAll(DROP_VIEW_RE)) {
      add(m.index ?? 0, splitNameList(m[1]), true);
    }
    for (const m of sql.matchAll(RENAME_TABLE_RE)) {
      // The old name stops resolving, the new one starts. Same offset, so
      // order them explicitly: drop first, then create.
      add(m.index ?? 0, [m[1].toLowerCase()], true);
      add((m.index ?? 0) + 1, [m[2].toLowerCase()], false);
    }
    events.sort((a, b) => a.at - b.at);
    for (const ev of events) {
      if (ev.drop) dropped.set(ev.name, file);
      else dropped.delete(ev.name);
    }
  }
  return dropped;
}

/**
 * Tables whose CREATE TABLE name was later renamed, or whose rows were
 * folded into another table. The guard follows the move and requires the
 * SUCCESSOR name to be handled by the privacy
 * modules, so a rename can never mask dropped coverage of the live table
 * (Bugbot finding, 2026-08-01: an exemption entry alone would keep CI green
 * even if deleteEndUserData stopped touching contacts).
 */
const RENAMED: Record<string, string> = {
  // 20260704000000_contacts_unify.sql renamed customer_memories to contacts
  // and folded contact_overrides into the same row set before dropping it.
  // Both map to contacts, so the successor's coverage is what CI checks.
  customer_memories: "contacts",
  contact_overrides: "contacts"
};

/**
 * Out-of-scope registry. Grouped by why; each entry is one deliberate
 * decision with its reason.
 */
const EXEMPT: Record<string, string> = {
  // Covered through another table.
  booking_claim_offers:
    "FK cascade from calendar_booking_dedupe (covered): the broadcast claim row (attendee name snapshot + invited teammate phones) dies with the booking's ledger row the erasure sweep already deletes",
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
  coworker_staff_mode:
    "per-tenant, per-surface staff toggles (business_id, surface key, boolean); no person columns, and the rows cascade with the business",
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
  contact_notes:
    "team-authored notes about a contact: owner work product, the business_documents boundary. Erasure severs the person key (deleting the person's contact row SET-NULLs contact_id, and the dashboard profile delete removes the rows outright); what remains is free-text owner content with no person columns",
  contact_segments: "saved list definitions (name + filter), not person rows",
  custom_tables:
    "owner-defined table definitions (name, description, column labels): configuration, not person data; the table carries no person columns",
  custom_table_rows:
    "records in the owner's own tables (policies, vehicles, memberships), the business_documents boundary. Erasure severs the person key BY DELETING the rows, not by SET-NULLing them: the contact-delete path calls deleteCustomTableRowsForContact, which removes the person's rows and the history snapshots that delete writes. What remains is owner-authored content with no person columns",
  custom_table_versions:
    "before-images of custom-table changes, so an AI edit can be undone. Person-linked snapshots go with the rows in deleteCustomTableRowsForContact; the rest are schema states (column labels), which carry no person columns",
  dashboard_chat_activity: "owner dashboard chat",
  dashboard_chat_jobs: "owner dashboard chat",
  dashboard_chat_threads: "owner dashboard chat",
  deals:
    "owner deal records (title/value/close/commission work product, same boundary as business_documents); the person linkage is contact_id, which detaches via on delete set null when erasure deletes the contact",
  email_campaigns: "owner-authored campaign content; recipients are covered separately",
  email_coworker_seen: "message-id dedupe set; no person columns",
  employee_time_off: "the business's own staff",
  enterprise_deals: "deal records about the tenant",
  onboarding_drafts: "the buyer's own onboarding answers (account scope)",
  social_posts: "owner marketing content",
  sessions: "legacy channel session ledger: channel + timestamps only",
  tenant_mailboxes: "the tenant's own mailbox provisioning",
  todos:
    "the team's own work checklist (title/details/due/assignee, same boundary as business_documents and deals); the person linkage is contact_id, which detaches via on delete set null when erasure deletes the contact",
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
  fub_import_jobs:
    "Follow Up Boss import job state: the tenant's own API key (encrypted, nullable, wiped on demand), aggregate counts, and a capped list of failure reasons keyed by FUB record ids, not our person rows. The imported people/notes/deals land in contacts/contact_notes/deals, which carry the erasure story; the job row cascades with the business",
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
      // The successor being covered is only half of it. Without this, a
      // RENAMED entry proves the live table is handled while the privacy
      // modules go on querying the dead name, which is the same abort this
      // whole guard exists to prevent, just reached through the map.
      expect(
        handled(oldName),
        `${oldName} no longer resolves; the privacy modules must not still name it ` +
          `(PostgREST answers a missing name with an error, and deleteEndUserData ` +
          `turns any error into a throw, so one stale name aborts the whole erasure)`
      ).toBe(false);
    }
  });

  it("the privacy modules never touch a name the schema no longer resolves", () => {
    const dropped = unresolvableNames();
    const zombies = [...dropped.keys()]
      .filter((name) => handled(name))
      .sort()
      .map((name) => `${name} (stopped resolving in ${dropped.get(name)})`);
    expect(
      zombies,
      "src/lib/privacy/deletion.ts or retention.ts still names these dropped tables. " +
        "PostgREST answers a query against a missing table with an error, and " +
        "deleteEndUserData turns any error into a throw, so ONE stale name aborts the " +
        "whole erasure request. That is what the contact_overrides block did between " +
        "contacts_unify and 2026-08-26, on BOTH identifier axes: a request carrying an " +
        "e164 seeds linkedNumbers with it unconditionally, and an email-only request " +
        "cross-links through collectLinkedIdentifiers, which harvests the matched " +
        "contact row's customer_e164 (NOT NULL, and itself an 'email:<addr>' key for a " +
        "contact known only by email). Only an email-only request matching zero " +
        "contacts got past it. Delete the block, or repoint it at the table that " +
        "absorbed the data."
    ).toEqual([]);
  });

  it("the unresolvable-name ledger is not vacuously green", () => {
    // The guard above only bites while the replay actually resolves names.
    // Pin the CASE, not a count: a count floor of 1 stays green if the replay
    // breaks and some unrelated future drop takes its place, and the whole
    // point of this ledger is that it keeps recognising THIS one.
    const dropped = unresolvableNames();
    expect(
      dropped.get("contact_overrides"),
      "the replay no longer sees contacts_unify dropping contact_overrides, so the " +
        "guard above is asserting over an empty set. Fix the replay, do not delete this."
    ).toBe("20260704000000_contacts_unify.sql");
    // customer_memories was renamed away by the same migration and then given
    // a compat view, so it must NOT read as unresolvable. This pins both the
    // rename and the view halves of the replay: drop either and this flips.
    expect(
      dropped.has("customer_memories"),
      "customer_memories resolves through the compat view contacts_unify created. " +
        "If this fails, the replay stopped modelling renames or views."
    ).toBe(false);
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
