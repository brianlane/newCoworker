/**
 * The box datastore must carry every column the dashboard reads through the
 * residency layer, for every table that layer routes.
 *
 * Why this exists: vps/data-api/schema.sql is GENERATED from a snapshot of
 * the central schema, so every column added centrally after that snapshot is
 * missing from a tenant's box until someone re-runs the generator. From the
 * 2026-07-07 snapshot onward that gap was closed by hand, one patch per
 * column, and a hand patch only ever covers the column somebody happened to
 * notice: on 2026-08-26 the box was twelve columns and seven CHECK
 * constraints behind central.
 *
 * A missing column does not answer with blanks. The data-api interpolates
 * column names into SQL, so a projection naming one fails the WHOLE select
 * and the card goes dark; a journal replay carrying one fails and replay
 * stops on its first failure, queueing every later write for that tenant.
 * This test turns both into a red check.
 *
 * Two layers, because they fail differently. The per-table lists below name
 * the columns a specific reader projects, so a failure says WHICH card goes
 * dark. The migration-derived block at the bottom demands FULL parity with
 * central for every moved table, because the journal replays whole rows and
 * a replay that hits a missing column stops, queueing every later write for
 * that tenant behind it. Parity is the real contract; the named lists are
 * the readable half of it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DETAIL_CALL_COLUMNS } from "@/lib/analytics/dashboard-analytics";
import { EMAIL_LOG_BOX_COLUMNS } from "@/lib/db/email-log";
import { RESIDENCY_MOVED_TABLES } from "@/lib/residency/tables";

import { balancedBody, splitTopLevel, stripSqlComments } from "./helpers/sql-ddl";

const SCHEMA_PATH = join(process.cwd(), "vps", "data-api", "schema.sql");
const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

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

/**
 * `notifications.delivery_channel` is the OTHER value-list the box pins, and
 * it is the one with the sharpest failure. `notifications` is a moved table,
 * so a tenant's rows replay onto their box; a channel the box's CHECK does
 * not know is rejected, and per this file's own header a replay that fails
 * "stops, queueing every later write for that tenant behind it". One push row
 * would not just lose itself, it would wedge that tenant's entire journal.
 *
 * The expectation is DERIVED from the TypeScript union rather than
 * hand-listed, so this cannot drift the way a copied list does, and every
 * future channel inherits the guard for free.
 */
describe("vps/data-api/schema.sql accepts every notification delivery channel", () => {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  const unionSource = readFileSync(
    join(__dirname, "..", "src/lib/db/notifications.ts"),
    "utf8"
  );

  const declared = [
    ...(/export type NotificationDeliveryChannel =([^;]+);/
      .exec(unionSource)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)
  ].map((m) => m[1]);

  it("finds the union, so this sweep is not vacuous", () => {
    expect(declared.length).toBeGreaterThan(1);
  });

  /**
   * Both sites: the create-table constraint for a fresh box, and the
   * drop/re-add for an existing one. `create table if not exists` never
   * refreshes a constraint, so patching only the first leaves every box that
   * already exists rejecting the new channel.
   */
  const checks = [
    ...sql.matchAll(/notifications_delivery_channel_check CHECK \(\(delivery_channel = ANY \(ARRAY\[([^\]]*)\]/g)
  ].map((m) => new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((v) => v[1])));

  it("patches both the create-table and the alter-table constraint", () => {
    expect(checks.length).toBe(2);
  });

  it.each(checks.map((set, i) => [i, set]))(
    "constraint %i accepts every declared channel",
    (_i, boxChannels) => {
      for (const channel of declared) {
        expect([...(boxChannels as Set<string>)]).toContain(channel);
      }
    }
  );
});

/**
 * `voice_call_transcripts` columns the box must carry, DERIVED from the
 * projection the call drill-down actually sends. Two of them,
 * `answering_machine_result` and `voicemail_left`, were missing from the box
 * between 20260822100237_voice_transcript_amd_columns and 2026-08-26, so the
 * analytics day-detail call list would have failed outright for the first
 * residency tenant instead of showing calls without an AMD verdict.
 */
describe("vps/data-api/schema.sql covers the voice_call_transcripts columns the dashboard reads", () => {
  const columns = boxColumns(readFileSync(SCHEMA_PATH, "utf8"), "voice_call_transcripts");

  it("parses the generated DDL (guards the parser itself, not just the columns)", () => {
    expect(columns.size).toBeGreaterThan(10);
    expect([...columns]).toContain("business_id");
  });

  it.each(DETAIL_CALL_COLUMNS.map((column) => ({ column })))(
    "declares $column (projected by the call drill-down)",
    ({ column }) => {
      expect([...columns].includes(column)).toBe(true);
    }
  );
});

/**
 * Tables whose central history is not all filed under their current name.
 * `contacts` was created as `customer_memories` and renamed in
 * 20260704000000_contacts_unify.sql, so every column it grew before that
 * date is recorded against the old name. Without the alias the scan below
 * would see a 6-column table and pass on a box missing most of it.
 */
const CENTRAL_NAME_HISTORY: Partial<Record<(typeof RESIDENCY_MOVED_TABLES)[number], string[]>> = {
  contacts: ["contacts", "customer_memories"]
};

const QUALIFIED = String.raw`(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?`;

/**
 * Every column name the migration corpus ever adds to each table, from the
 * two statements that add one: a `create table` body and
 * `alter table ... add column`.
 *
 * Additive on purpose. A column central later DROPPED is still reported as
 * required here, and that is the safe direction: an extra column on the box
 * costs a few bytes, while a missing one fails a whole statement. Being
 * additive is also what keeps the scan honest without a rename/drop ledger
 * to maintain, which is the part that rots.
 *
 * Validated against the live central schema on 2026-08-26: the sets this
 * produces matched information_schema exactly, name for name, for all 15
 * moved tables (189 columns). It is a derivation, not an approximation.
 */
function centralColumnsByTable(): Map<string, Map<string, string>> {
  const byTable = new Map<string, Map<string, string>>();
  const record = (table: string, column: string, file: string): void => {
    let columns = byTable.get(table);
    if (!columns) byTable.set(table, (columns = new Map()));
    if (!columns.has(column)) columns.set(column, file);
  };

  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));

    const createRe = new RegExp(
      String.raw`create\s+table\s+(?:if\s+not\s+exists\s+)?${QUALIFIED}\s*\(`,
      "gi"
    );
    for (const match of sql.matchAll(createRe)) {
      const open = match.index + match[0].length - 1;
      const body = balancedBody(sql, open);
      if (body === null) continue;
      for (const part of splitTopLevel(body)) {
        const first = /^\s*"?([a-z_][a-z0-9_]*)"?\s+/i.exec(part);
        if (!first) continue;
        const word = first[1].toLowerCase();
        // Table-level constraint clauses, not columns.
        if (["constraint", "primary", "unique", "foreign", "check", "exclude", "like"].includes(word)) {
          continue;
        }
        record(match[1].toLowerCase(), word, file);
      }
    }

    // One statement can carry several `add column` clauses, hence the inner
    // scan over the whole statement rather than a single capture.
    const alterRe = new RegExp(
      String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QUALIFIED}([\s\S]*?);`,
      "gi"
    );
    for (const match of sql.matchAll(alterRe)) {
      for (const added of match[2].matchAll(
        /\badd\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi
      )) {
        record(match[1].toLowerCase(), added[1].toLowerCase(), file);
      }
    }
  }
  return byTable;
}

describe("vps/data-api/schema.sql carries every column central gave a moved table", () => {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  const central = centralColumnsByTable();

  /**
   * The scan is the thing that can silently stop working: a regex that
   * matches nothing turns this whole block into a no-op that passes forever.
   * Pin a column that only exists because each branch of the scan works: a
   * create-table body under the pre-rename name, and a much later
   * `add column` under the current one.
   */
  it("derives central columns from the migrations (guards the scan, not just the schema)", () => {
    expect(central.get("customer_memories")?.has("customer_e164")).toBe(true);
    expect(central.get("contacts")?.get("lead_source")).toBe(
      "20260822035302_lead_source_and_lifecycle_stages.sql"
    );
    expect(central.get("email_log")?.size).toBeGreaterThan(20);
  });

  it.each(RESIDENCY_MOVED_TABLES.map((table) => ({ table })))(
    "$table has no column central added that the box lacks",
    ({ table }) => {
      const box = boxColumns(sql, table);
      expect(box.size).toBeGreaterThan(2);

      const required = new Map<string, string>();
      for (const name of CENTRAL_NAME_HISTORY[table] ?? [table]) {
        for (const [column, file] of central.get(name) ?? []) {
          if (!required.has(column)) required.set(column, file);
        }
      }
      expect(required.size).toBeGreaterThan(2);

      const missing = [...required].filter(([column]) => !box.has(column));
      // Name the migration that added each one AND the remedy, so a failure
      // is a command to run rather than an archaeology dig.
      expect(
        missing.map(([column, file]) => `${table}.${column} (added by ${file})`),
        `${table} is behind central. Re-run: npx tsx debug/generate-residency-ddl.ts ` +
          "(needs SUPABASE_DB_URL; it reads the live catalog and rewrites " +
          "vps/data-api/schema.sql for every moved table)"
      ).toEqual([]);
    }
  );
});

/**
 * `create table if not exists` is a no-op on a box that already has the
 * table, so a CHECK declared only in the create body never reaches an
 * existing volume. When central WIDENS one (a new `source`, a new
 * `last_channel`), the box keeps the narrow version and REJECTS the row, and
 * the replayer stops on its first failure. The generator therefore re-emits
 * every CHECK as a drop/add pair after the column ALTERs; this asserts the
 * pair is actually there, for every table, so a future generator edit cannot
 * quietly drop the repair the way the hand-patched era did.
 */
describe("vps/data-api/schema.sql refreshes its CHECK constraints for an existing box", () => {
  const sql = readFileSync(SCHEMA_PATH, "utf8");

  it.each(RESIDENCY_MOVED_TABLES.map((table) => ({ table })))(
    "$table drops its stale CHECKs before re-adding them",
    ({ table }) => {
      expect(sql).toContain(
        `where conrelid = '${table}'::regclass and contype = 'c' loop`
      );
    }
  );

  it.each(RESIDENCY_MOVED_TABLES.map((table) => ({ table })))(
    "$table re-adds every CHECK its create body declares",
    ({ table }) => {
      const create = new RegExp(
        `create table if not exists ${table} \\(([\\s\\S]*?)\\n\\);`,
        "i"
      ).exec(sql);
      expect(create).not.toBeNull();
      const declared = [
        ...(create?.[1] ?? "").matchAll(/constraint ([a-z_][a-z0-9_]*) CHECK/gi)
      ].map((m) => m[1]);
      const unrefreshed = declared.filter(
        (name) => !sql.includes(`alter table ${table} add constraint ${name} CHECK`)
      );
      expect(unrefreshed).toEqual([]);
    }
  );
});
