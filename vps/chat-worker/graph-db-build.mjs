/**
 * Compile the on-box knowledge-graph projection (graph.jsonl, shipped by
 * the platform's vault sync) into a queryable SQLite database — the "real
 * SQLite KG on the tenant's own box".
 *
 * Rebuilds are cheap and idempotent: we rebuild whenever graph.jsonl is
 * newer than graph.db (or the db is missing), writing to a temp file and
 * renaming so a crash mid-build never leaves a corrupt db. A box whose
 * tenant is not on the graph simply has no graph.jsonl — permanent no-op.
 *
 * Uses node:sqlite (built-in — no new dependency, no extra container).
 * Wrapped defensively: any failure logs and skips; the worker's chat
 * duties are never affected.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Where the vault sync unpacks the projection (compose mounts it in). */
export const DEFAULT_MEMORY_DIR = "/opt/rowboat/memory";

// Single-flight guard: startup + interval callers never overlap on the
// same graph.db.tmp (a slow build racing another corrupts the rename).
let building = false;

/**
 * Build (or refresh) graph.db from graph.jsonl.
 *
 * Freshness is CONTENT-HASH based, not mtime based: the tar the vault sync
 * unpacks carries epoch mtimes, so "db newer than jsonl" would be true
 * forever after the first compile and later syncs would never rebuild. The
 * source sha256 is stored in a `meta` table inside graph.db and compared
 * against the current file.
 *
 * Returns { built, reason } for logging/tests; never throws.
 */
export async function maybeBuildGraphDb({ memoryDir = DEFAULT_MEMORY_DIR, log = () => {} } = {}) {
  if (building) return { built: false, reason: "busy" };
  building = true;
  try {
    const jsonlPath = path.join(memoryDir, "graph.jsonl");
    const dbPath = path.join(memoryDir, "graph.db");
    let raw;
    try {
      raw = fs.readFileSync(jsonlPath, "utf8");
    } catch {
      return { built: false, reason: "no_jsonl" };
    }
    const sourceSha = crypto.createHash("sha256").update(raw).digest("hex");

    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      return { built: false, reason: "sqlite_unavailable" };
    }

    if (fs.existsSync(dbPath)) {
      try {
        const existing = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const row = existing
            .prepare("select value from meta where key = 'source_sha256'")
            .get();
          if (row && row.value === sourceSha) {
            return { built: false, reason: "up_to_date" };
          }
        } finally {
          existing.close();
        }
      } catch {
        // Unreadable/corrupt/pre-meta db — rebuild it.
      }
    }

    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const tmpPath = `${dbPath}.tmp`;
    fs.rmSync(tmpPath, { force: true });
    const db = new DatabaseSync(tmpPath);
    let entities = 0;
    let facts = 0;
    try {
      db.exec(`
        create table meta (
          key text primary key,
          value text not null
        );
        create table entities (
          id text primary key,
          kind text not null,
          name text not null,
          aliases text not null default '[]',
          phones text not null default '[]',
          emails text not null default '[]',
          updated_at text
        );
        create table facts (
          id text primary key,
          subject_id text not null,
          predicate text not null,
          object_id text,
          object_value text,
          source_text text,
          stated_at text
        );
        create index idx_facts_subject on facts (subject_id);
        create index idx_facts_object on facts (object_id);
      `);
      const insertEntity = db.prepare(
        "insert or replace into entities (id, kind, name, aliases, phones, emails, updated_at) values (?, ?, ?, ?, ?, ?, ?)"
      );
      const insertFact = db.prepare(
        "insert or replace into facts (id, subject_id, predicate, object_id, object_value, source_text, stated_at) values (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const line of lines) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue; // a torn line never poisons the rest of the build
        }
        if (row?.type === "entity" && row.id && row.name) {
          insertEntity.run(
            String(row.id),
            String(row.kind ?? "other"),
            String(row.name),
            JSON.stringify(row.aliases ?? []),
            JSON.stringify(row.phones ?? []),
            JSON.stringify(row.emails ?? []),
            row.updated_at ? String(row.updated_at) : null
          );
          entities += 1;
        } else if (row?.type === "fact" && row.id && row.subject_id && row.predicate) {
          insertFact.run(
            String(row.id),
            String(row.subject_id),
            String(row.predicate),
            row.object_id ? String(row.object_id) : null,
            row.object_value === null || row.object_value === undefined
              ? null
              : String(row.object_value),
            row.source_text ? String(row.source_text) : null,
            row.stated_at ? String(row.stated_at) : null
          );
          facts += 1;
        }
      }
      db.prepare("insert into meta (key, value) values ('source_sha256', ?)").run(sourceSha);
    } finally {
      db.close();
    }
    fs.renameSync(tmpPath, dbPath);
    log("info", "graph_db_built", { entities, facts, dbPath });
    return { built: true, entities, facts };
  } catch (err) {
    log("warn", "graph_db_build_failed", { error: err?.message || String(err) });
    return { built: false, reason: "error" };
  } finally {
    building = false;
  }
}
