/**
 * The box datastore must carry every column the dashboard reads through the
 * residency layer, for every table that layer routes.
 *
 * Why this exists: vps/data-api/schema.sql is GENERATED from a central
 * schema snapshot (2026-07-07) and then hand-patched, so a column added
 * centrally after that date silently does not exist on a tenant's box.
 * `tags` and `owner_employee_id` (20260709213842_contact_tags_ownership) and
 * `lead_source` (20260822035302_lead_source_and_lifecycle_stages) all landed
 * after the snapshot. A projection naming a missing column does not return
 * blanks, it fails the whole SELECT, so the lead-source, quote-funnel and
 * deals cards would have gone dark for the first data-residency tenant, and
 * the journal replay of a contacts row carrying those columns would have
 * failed too. This test turns the drift into a red check.
 *
 * It guards the columns our code actually asks for, not full parity with
 * central: a column nothing reads or replicates can stay absent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EMAIL_LOG_BOX_COLUMNS } from "@/lib/db/email-log";

const SCHEMA_PATH = join(process.cwd(), "vps", "data-api", "schema.sql");

/**
 * Column names the box schema declares for one table, from both forms the
 * generated DDL uses: the `create table` body and the idempotent
 * `alter table ... add column if not exists` upgrade lines.
 */
function boxColumns(sql: string, table: string): Set<string> {
  const columns = new Set<string>();
  const create = new RegExp(`create table if not exists ${table} \\(([\\s\\S]*?)\\n\\);`, "i").exec(
    sql
  );
  if (create) {
    for (const line of create[1].split("\n")) {
      const name = /^\s{2}([a-z_][a-z0-9_]*)\s+[a-z]/i.exec(line);
      // Skip the constraint lines, which start with `constraint`.
      if (name && name[1].toLowerCase() !== "constraint") columns.add(name[1]);
    }
  }
  const added = new RegExp(
    `alter table ${table} add column if not exists ([a-z_][a-z0-9_]*)`,
    "gi"
  );
  for (const match of sql.matchAll(added)) columns.add(match[1]);
  return columns;
}

/**
 * Every `contacts` column the residency-routed dashboard reads project or
 * filter on, with the reader that needs it.
 */
const REQUIRED_CONTACT_COLUMNS: Array<{ column: string; readers: string }> = [
  { column: "id", readers: "renewal-pipeline, deals, monthly-summary count" },
  { column: "business_id", readers: "every scan's tenant filter" },
  { column: "type", readers: "the customer-only filter on every card" },
  { column: "created_at", readers: "lead-sources, engagement, retention, monthly-summary" },
  { column: "customer_e164", readers: "engagement, renewal-pipeline, employee-performance" },
  { column: "display_name", readers: "engagement, renewal-pipeline" },
  { column: "alias_e164s", readers: "employee-performance touch identities" },
  { column: "email", readers: "employee-performance touch identities" },
  { column: "last_interaction_at", readers: "engagement, retention" },
  { column: "total_interaction_count", readers: "lead-sources, engagement, retention" },
  { column: "last_channel", readers: "lead-sources" },
  { column: "lead_source", readers: "lead-sources, deals" },
  { column: "tags", readers: "lead-sources, quote-funnel" },
  { column: "owner_employee_id", readers: "lead-sources, deals" }
];

/**
 * Every `ai_flows` column the routed readers project or filter on. The flows
 * table joined the residency layer after `contacts` did, and its
 * `enabled_changed_at` was missing from the box for exactly the reason this
 * whole file exists: it landed centrally after the snapshot.
 */
const REQUIRED_AI_FLOW_COLUMNS: Array<{ column: string; readers: string }> = [
  { column: "id", readers: "listAiFlows, getAiFlow, listAiFlowDefinitions" },
  { column: "business_id", readers: "every routed flow read's tenant filter" },
  { column: "name", readers: "listAiFlows, getAiFlow, listAiFlowDefinitions" },
  { column: "enabled", readers: "listAiFlows, getAiFlow" },
  { column: "definition", readers: "listAiFlowDefinitions, enqueue gates" },
  { column: "created_by", readers: "listAiFlows, getAiFlow" },
  { column: "created_at", readers: "listAiFlows order, getAiFlow" },
  { column: "updated_at", readers: "listAiFlows, getAiFlow" },
  { column: "enabled_changed_at", readers: "listAiFlows, getAiFlow" },
  { column: "deleted_at", readers: "listAiFlows and getAiFlow filters, enqueue soft-delete gate" }
];

describe("vps/data-api/schema.sql covers the ai_flows columns the dashboard reads", () => {
  const columns = boxColumns(readFileSync(SCHEMA_PATH, "utf8"), "ai_flows");

  it("parses the generated DDL (guards the parser itself, not just the columns)", () => {
    expect(columns.size).toBeGreaterThan(5);
  });

  it.each(REQUIRED_AI_FLOW_COLUMNS)("declares $column (read by $readers)", ({ column }) => {
    expect([...columns].includes(column)).toBe(true);
  });
});

describe("vps/data-api/schema.sql covers the contacts columns the dashboard reads", () => {
  const columns = boxColumns(readFileSync(SCHEMA_PATH, "utf8"), "contacts");

  it("parses the generated DDL (guards the parser itself, not just the columns)", () => {
    expect(columns.size).toBeGreaterThan(10);
  });

  it.each(REQUIRED_CONTACT_COLUMNS)("declares $column (read by $readers)", ({ column }) => {
    expect([...columns].includes(column)).toBe(true);
  });
});

/**
 * `email_log` columns the box must carry, DERIVED from the projection the
 * routed reader actually sends rather than hand-listed.
 *
 * Hand-listing is what let this drift in the first place. email_log has been
 * residency-routed since the layer shipped and was never added to this file,
 * so `importance` (20260812000000), `thread_id` and `message_ref`
 * (20260822083502) all sat missing from the box until 2026-08-26, found only
 * because Bugbot flagged the delivery columns landing on the same pile.
 *
 * The extras below are the columns other routed paths need but the list
 * projection does not name: the reading pane's body fetch, the soft-delete
 * filter every list applies, and the two thread-identity columns, which no
 * box read projects but the JOURNAL REPLAY carries. That last one is the
 * dangerous case: a replay hitting a missing column fails, and replay stops
 * on the first failure, so every later residency write for that tenant queues
 * behind it.
 */
const EMAIL_LOG_EXTRA_COLUMNS: Array<{ column: string; readers: string }> = [
  { column: "body_full", readers: "getEmailBody, the reading pane" },
  { column: "body_html", readers: "getEmailBody, the reading pane" },
  { column: "attachments", readers: "getEmailBody attachment list" },
  { column: "deleted_at", readers: "the soft-delete filter on every list" },
  { column: "thread_id", readers: "journal replay of a threaded row" },
  { column: "message_ref", readers: "journal replay of a threaded row" }
];

describe("vps/data-api/schema.sql covers the email_log columns the dashboard reads", () => {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  const columns = boxColumns(sql, "email_log");

  it("parses the generated DDL (guards the parser itself, not just the columns)", () => {
    expect(columns.size).toBeGreaterThan(15);
    expect([...columns]).toContain("business_id");
  });

  it.each(EMAIL_LOG_BOX_COLUMNS.map((column) => ({ column })))(
    "declares $column (projected by listEmailLog)",
    ({ column }) => {
      expect([...columns].includes(column)).toBe(true);
    }
  );

  it.each(EMAIL_LOG_EXTRA_COLUMNS)("declares $column (read by $readers)", ({ column }) => {
    expect([...columns].includes(column)).toBe(true);
  });

  /**
   * The check constraint is the other half. `create table if not exists`
   * never refreshes a constraint on an existing box, so a source added
   * centrally is REJECTED there until the drop/re-add below is patched too,
   * and the replayer wedges on the first such row. The box list was four
   * sources behind central on 2026-08-26.
   */
  it("accepts every source the app can write", () => {
    const constraint = /add constraint email_log_source_check CHECK \(\(source = ANY \(ARRAY\[([^\]]*)\]/.exec(
      sql
    );
    expect(constraint).not.toBeNull();
    const boxSources = new Set(
      [...(constraint?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    );
    // Mirrors the EmailLogSource union in src/lib/db/email-log.ts.
    for (const source of [
      "ai_flow",
      "owner_mailbox",
      "email_trigger",
      "dashboard_chat",
      "sms_assistant",
      "voice_assistant",
      "slack_assistant",
      "tenant_mailbox_inbound",
      "tenant_mailbox_outbound",
      "owner_manual",
      "email_coworker",
      "booking_reminder",
      "notification"
    ]) {
      expect([...boxSources]).toContain(source);
    }
  });
});
