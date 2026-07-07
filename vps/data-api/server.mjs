/**
 * Residency data API — single-tenant CRUD front for the box-local Postgres
 * that holds this tenant's customer content (the residency moved tables).
 *
 * Deployed by vps/scripts/deploy-client.sh ONLY when the orchestrator passes
 * DATA_RESIDENCY_ENABLED=true (enterprise tier + data_residency_mode past
 * 'supabase'). Published through the tenant's Cloudflare tunnel at
 * `data-<businessId>.<zone>` → 127.0.0.1:8091; Postgres itself never leaves
 * the private docker network.
 *
 * Wire contract: src/lib/residency/contract.ts (generic filter-based
 * select/insert/update/delete + GET /v1/health). Keep the two in lockstep.
 *
 * Auth: every /v1/* POST requires `Authorization: Bearer <token>` matching
 * one of DATA_API_TOKENS (comma-separated). Multiple tokens are accepted so
 * the platform's pending/confirmed gateway-token rotation overlap never
 * drops requests; comparison is timing-safe.
 *
 * HTTP semantics: 401/400 for client errors (Cloudflare passes 4xx bodies
 * through) but HTTP 200 + { ok:false, error:"internal" } for server-side
 * failures — the tunnel REPLACES origin 5xx bodies with its own error page
 * (same rationale as vps/aiflow-render/server.mjs), which would erase the
 * structured error the caller needs to decide fallback-vs-retry.
 *
 * Env (written by deploy-client.sh):
 *   DATA_API_PORT     default 8091
 *   DATA_API_TOKENS   comma-separated bearer tokens (required)
 *   DATABASE_URL      postgres:// URL for the box datastore (required)
 */
import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import pg from "pg";

const PORT = Number(process.env.DATA_API_PORT ?? 8091);
const TOKENS = (process.env.DATA_API_TOKENS ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter((t) => t.length > 0);
const DATABASE_URL = process.env.DATABASE_URL ?? "";

if (TOKENS.length === 0) {
  console.error("FATAL: DATA_API_TOKENS is required (comma-separated bearer tokens)");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is required");
  process.exit(1);
}

/**
 * Tables this API will touch. MUST stay in lockstep with
 * RESIDENCY_MOVED_TABLES in src/lib/residency/tables.ts — this service has
 * no build step against the app repo, so the list is mirrored here the same
 * way the other vps sidecars mirror shared constants.
 */
const MOVED_TABLES = new Set([
  "contacts",
  "dashboard_chat_threads",
  "dashboard_chat_messages",
  "dashboard_chat_activity",
  "email_log",
  "voice_call_transcripts",
  "voice_call_transcript_turns",
  "voice_outbound_dial_log",
  "sms_outbound_log",
  "sms_rowboat_threads",
  "sms_owner_reply_prompts",
  "scheduled_sms",
  "notifications",
  "ai_flows",
  "aiflow_url_memory"
]);

const FILTER_OPS = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
  ilike: "ILIKE"
};

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Quote an identifier for SQL interpolation. Every identifier is ALSO
 * validated against IDENT_RE first (assertColumns / compileFilters), so this
 * is defense-in-depth: pg's escapeIdentifier double-quotes the name and
 * escapes embedded quotes, making the interpolation inert even if a
 * validator regression let a hostile name through.
 */
function quoteIdent(name) {
  return pg.escapeIdentifier(name);
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  // The box serves exactly one tenant; a handful of connections is ample and
  // keeps the memory-capped Postgres comfortably inside its mem_limit.
  max: 5,
  idleTimeoutMillis: 30_000
});

/** Timing-safe bearer check against every configured token (sha256-padded). */
function bearerOk(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = createHash("sha256").update(header.slice(7).trim(), "utf8").digest();
  let ok = false;
  for (const token of TOKENS) {
    const expected = createHash("sha256").update(token, "utf8").digest();
    // Constant-length digests -> timingSafeEqual never throws; OR-accumulate
    // so every token is compared regardless of early matches.
    if (timingSafeEqual(presented, expected)) ok = true;
  }
  return ok;
}

function clientError(res, status, error, message) {
  return res.status(status).json({ ok: false, error, message });
}

/**
 * Validate + compile a filter list into a parameterized WHERE clause.
 * Returns { sql, values } or throws { code, message }.
 */
function compileFilters(filters, values) {
  if (filters == null) return "";
  if (!Array.isArray(filters)) {
    throw { code: "invalid_request", message: "filters must be an array" };
  }
  const parts = [];
  for (const f of filters) {
    if (f == null || typeof f !== "object") {
      throw { code: "invalid_request", message: "filter entries must be objects" };
    }
    const { column, op, value } = f;
    if (typeof column !== "string" || !IDENT_RE.test(column)) {
      throw { code: "invalid_request", message: `invalid filter column: ${String(column)}` };
    }
    if (op === "is") {
      if (value !== null) {
        throw { code: "invalid_request", message: "filter op 'is' only supports null" };
      }
      parts.push(`${quoteIdent(column)} IS NULL`);
    } else if (op === "in") {
      if (!Array.isArray(value) || value.length === 0) {
        throw { code: "invalid_request", message: "filter op 'in' needs a non-empty array" };
      }
      const placeholders = value.map((v) => {
        values.push(v);
        return `$${values.length}`;
      });
      parts.push(`${quoteIdent(column)} IN (${placeholders.join(", ")})`);
    } else if (op in FILTER_OPS) {
      if (value === null || value === undefined || Array.isArray(value)) {
        throw { code: "invalid_request", message: `filter op '${op}' needs a scalar value` };
      }
      values.push(value);
      parts.push(`${quoteIdent(column)} ${FILTER_OPS[op]} $${values.length}`);
    } else {
      throw { code: "invalid_request", message: `unknown filter op: ${String(op)}` };
    }
  }
  return parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "";
}

function requireTable(body) {
  const requested = body?.table;
  // Resolve to the SET's own member (not the request string) so the value
  // interpolated into SQL is a trusted constant — taint from the request
  // body never reaches a query string, whitelist aside.
  const table = [...MOVED_TABLES].find((t) => t === requested);
  if (table === undefined) {
    throw { code: "unknown_table", message: `unknown table: ${String(requested)}` };
  }
  return table;
}

function assertColumns(cols, label) {
  for (const c of cols) {
    if (typeof c !== "string" || !IDENT_RE.test(c)) {
      throw { code: "invalid_request", message: `invalid ${label}: ${String(c)}` };
    }
  }
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

// The platform (dashboard + Edge workers) is the only legitimate caller, so
// the ceiling is generous — this exists to bound a runaway loop or a stolen
// token's blast radius, not to throttle normal traffic. Same middleware the
// aiflow-render sidecar uses.
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.get("/v1/health", async (_req, res) => {
  try {
    const meta = await pool.query(
      "select value from residency_schema_meta where key = 'generated_at'"
    );
    res.json({ ok: true, schemaVersion: meta.rows[0]?.value ?? "unknown" });
  } catch (err) {
    // Health must be honest: a broken datastore is NOT healthy — but keep the
    // status 200 so the tunnel doesn't mask the body (see header comment).
    res.json({ ok: false, schemaVersion: "unreachable", message: String(err?.message ?? err) });
  }
});

app.use("/v1", (req, res, next) => {
  if (!bearerOk(req.headers.authorization)) {
    return clientError(res, 401, "unauthorized", "missing or invalid bearer token");
  }
  next();
});

app.post("/v1/select", async (req, res) => {
  try {
    const table = requireTable(req.body);
    const { columns, filters, order, limit, offset, count } = req.body;
    const values = [];
    let projection = "*";
    if (columns !== undefined) {
      if (!Array.isArray(columns) || columns.length === 0) {
        throw { code: "invalid_request", message: "columns must be a non-empty array" };
      }
      assertColumns(columns, "column");
      projection = columns.map(quoteIdent).join(", ");
    }
    let sql = `SELECT ${projection} FROM ${table}${compileFilters(filters, values)}`;
    if (order !== undefined) {
      if (!Array.isArray(order) || order.length === 0) {
        throw { code: "invalid_request", message: "order must be a non-empty array" };
      }
      assertColumns(order.map((o) => o?.column), "order column");
      sql += ` ORDER BY ${order
        .map((o) => `${quoteIdent(o.column)} ${o.ascending ? "ASC" : "DESC"}`)
        .join(", ")}`;
    }
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 0) {
        throw { code: "invalid_request", message: "limit must be a non-negative integer" };
      }
      values.push(limit);
      sql += ` LIMIT $${values.length}`;
    }
    if (offset !== undefined) {
      if (!Number.isInteger(offset) || offset < 0) {
        throw { code: "invalid_request", message: "offset must be a non-negative integer" };
      }
      values.push(offset);
      sql += ` OFFSET $${values.length}`;
    }
    const result = await pool.query(sql, values);
    const payload = { ok: true, rows: result.rows };
    if (count === true) {
      const countValues = [];
      const countSql = `SELECT count(*)::bigint AS n FROM ${table}${compileFilters(filters, countValues)}`;
      const c = await pool.query(countSql, countValues);
      payload.count = Number(c.rows[0].n);
    }
    res.json(payload);
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/v1/insert", async (req, res) => {
  try {
    const table = requireTable(req.body);
    const { rows, onConflict, returning } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw { code: "invalid_request", message: "rows must be a non-empty array" };
    }
    const columns = Object.keys(rows[0]);
    if (columns.length === 0) {
      throw { code: "invalid_request", message: "rows must have at least one column" };
    }
    assertColumns(columns, "column");
    for (const row of rows) {
      const keys = Object.keys(row);
      if (keys.length !== columns.length || keys.some((k) => !columns.includes(k))) {
        throw { code: "invalid_request", message: "every row must have the same columns" };
      }
    }
    const values = [];
    const tuples = rows.map(
      (row) =>
        `(${columns
          .map((c) => {
            values.push(normalizeValue(row[c]));
            return `$${values.length}`;
          })
          .join(", ")})`
    );
    let sql = `INSERT INTO ${table} (${columns.map(quoteIdent).join(", ")}) VALUES ${tuples.join(", ")}`;
    if (onConflict !== undefined) {
      if (!Array.isArray(onConflict) || onConflict.length === 0) {
        throw { code: "invalid_request", message: "onConflict must be a non-empty array" };
      }
      assertColumns(onConflict, "onConflict column");
      const updates = columns
        .filter((c) => !onConflict.includes(c))
        .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`);
      sql +=
        updates.length > 0
          ? ` ON CONFLICT (${onConflict.map(quoteIdent).join(", ")}) DO UPDATE SET ${updates.join(", ")}`
          : ` ON CONFLICT (${onConflict.map(quoteIdent).join(", ")}) DO NOTHING`;
    }
    if (returning === true) sql += " RETURNING *";
    const result = await pool.query(sql, values);
    res.json({ ok: true, rows: returning === true ? result.rows : [] });
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/v1/update", async (req, res) => {
  try {
    const table = requireTable(req.body);
    const { set, filters, returning } = req.body;
    if (set == null || typeof set !== "object" || Array.isArray(set)) {
      throw { code: "invalid_request", message: "set must be an object" };
    }
    const columns = Object.keys(set);
    if (columns.length === 0) {
      throw { code: "invalid_request", message: "set must have at least one column" };
    }
    assertColumns(columns, "set column");
    if (!Array.isArray(filters) || filters.length === 0) {
      // Hard rule from the contract: no accidental full-table updates.
      throw { code: "invalid_request", message: "update requires at least one filter" };
    }
    const values = [];
    const assignments = columns.map((c) => {
      values.push(normalizeValue(set[c]));
      return `${quoteIdent(c)} = $${values.length}`;
    });
    let sql = `UPDATE ${table} SET ${assignments.join(", ")}${compileFilters(filters, values)}`;
    if (returning === true) sql += " RETURNING *";
    const result = await pool.query(sql, values);
    res.json({ ok: true, rows: returning === true ? result.rows : [] });
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/v1/delete", async (req, res) => {
  try {
    const table = requireTable(req.body);
    const { filters, returning } = req.body;
    if (!Array.isArray(filters) || filters.length === 0) {
      // Hard rule from the contract: no accidental full-table deletes.
      throw { code: "invalid_request", message: "delete requires at least one filter" };
    }
    const values = [];
    let sql = `DELETE FROM ${table}${compileFilters(filters, values)}`;
    if (returning === true) sql += " RETURNING *";
    const result = await pool.query(sql, values);
    res.json({ ok: true, rows: returning === true ? result.rows : [] });
  } catch (err) {
    handleError(res, err);
  }
});

/** JSON/array values must reach pg as JSON text for json/jsonb columns. */
function normalizeValue(v) {
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

function handleError(res, err) {
  if (err && typeof err === "object" && typeof err.code === "string" && err.message) {
    if (err.code === "unknown_table" || err.code === "invalid_request") {
      return clientError(res, 400, err.code, err.message);
    }
  }
  // Postgres unique violations surface as a structured conflict so dual-write
  // reconciliation can distinguish "already written" from real failures.
  if (err && err.code === "23505") {
    return res.status(200).json({ ok: false, error: "conflict", message: err.detail ?? err.message });
  }
  console.error("data-api internal error", { message: String(err?.message ?? err) });
  // HTTP 200 on purpose — see the header comment (Cloudflare eats 5xx bodies).
  return res.status(200).json({ ok: false, error: "internal", message: "internal error" });
}

app.listen(PORT, () => {
  console.log(`data-api listening on :${PORT} (${MOVED_TABLES.size} tables)`);
});
