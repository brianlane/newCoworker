/**
 * Filter and identifier compilation for the residency data API.
 *
 * Extracted from server.mjs so it can be unit-tested. server.mjs exits at
 * import time without DATABASE_URL, so while this lived there the one part
 * of the service that turns a request body into SQL had no tests at all.
 *
 * The safety contract, unchanged from where it started:
 *   * every VALUE becomes a $n placeholder, never string-interpolated;
 *   * every COLUMN is checked against IDENT_RE and then double-quoted;
 *   * an unknown op is a hard invalid_request, never a silent no-op, so a
 *     box older than the caller REFUSES a filter it cannot express rather
 *     than quietly returning rows for a narrower query. That is what makes
 *     rolling the grammar forward safe: the failure is loud and typed
 *     (ResidencyReadError on the platform side), never wrong data.
 *
 * MUST stay in lockstep with src/lib/residency/contract.ts. This service has
 * no build step against the app repo, so the list is mirrored rather than
 * imported; tests/residency-box-grammar-lockstep.test.ts pins the two.
 */

import pg from "pg";

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Quote an identifier for SQL interpolation. Every identifier is ALSO
 * validated against IDENT_RE first (assertColumns / compileCondition), so
 * this is defense-in-depth: pg's escapeIdentifier double-quotes the name and
 * escapes embedded quotes, making the interpolation inert even if a
 * validator regression let a hostile name through.
 */
function quoteIdent(name) {
  return pg.escapeIdentifier(name);
}

function assertColumns(cols, label) {
  for (const c of cols) {
    if (typeof c !== "string" || !IDENT_RE.test(c)) {
      throw { code: "invalid_request", message: `invalid ${label}: ${String(c)}` };
    }
  }
}

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

/**
 * Array operators for the `text[]` columns the dashboard filters on
 * (`contacts.tags`, `contacts.alias_e164s`, `email_log.labels`). The
 * parameter is cast to text[] explicitly, because Postgres cannot always
 * infer a placeholder's type from the `@>` operator alone.
 */
const ARRAY_OPS = {
  contains: "@>",
  overlaps: "&&"
};

/** Advertised from /v1/health so a stale box is detectable before a flip. */
const SUPPORTED_FILTER_OPS = [
  ...Object.keys(FILTER_OPS),
  "in",
  "is",
  ...Object.keys(ARRAY_OPS)
];

/**
 * Compile ONE condition into a parameterized SQL fragment.
 *
 * `negate` wraps the fragment in NOT (...), except IS NULL which becomes IS
 * NOT NULL directly. That matches PostgREST: `.not(col, "eq", v)` compiles
 * to NOT (col = v), which also excludes NULL rows. Matching it means the box
 * and central agree on the awkward case, rather than each being separately
 * defensible and quietly returning different row counts.
 */
function compileCondition(f, values) {
  if (f == null || typeof f !== "object") {
    throw { code: "invalid_request", message: "filter entries must be objects" };
  }
  const { column, op, value, negate } = f;
  if (typeof column !== "string" || !IDENT_RE.test(column)) {
    throw { code: "invalid_request", message: `invalid filter column: ${String(column)}` };
  }
  if (negate !== undefined && typeof negate !== "boolean") {
    throw { code: "invalid_request", message: "filter 'negate' must be a boolean" };
  }
  const wrap = (sql) => (negate === true ? `NOT (${sql})` : sql);

  if (op === "is") {
    if (value !== null) {
      throw { code: "invalid_request", message: "filter op 'is' only supports null" };
    }
    // Written directly rather than through wrap(): NOT (x IS NULL) is
    // equivalent, but IS NOT NULL is what a partial index matches and what a
    // reader expects to see in a slow-query log.
    return `${quoteIdent(column)} IS ${negate === true ? "NOT " : ""}NULL`;
  }

  if (op === "in") {
    if (!Array.isArray(value) || value.length === 0) {
      throw { code: "invalid_request", message: "filter op 'in' needs a non-empty array" };
    }
    const placeholders = value.map((v) => {
      values.push(v);
      return `$${values.length}`;
    });
    return wrap(`${quoteIdent(column)} IN (${placeholders.join(", ")})`);
  }

  if (Object.prototype.hasOwnProperty.call(ARRAY_OPS, op)) {
    if (!Array.isArray(value) || value.length === 0) {
      throw { code: "invalid_request", message: `filter op '${op}' needs a non-empty array` };
    }
    if (value.some((v) => typeof v !== "string")) {
      throw {
        code: "invalid_request",
        message: `filter op '${op}' is for text[] columns, so every value must be a string`
      };
    }
    // One placeholder holding the whole array: pg adapts a JS string[] to a
    // Postgres array literal, so no element is ever interpolated.
    values.push(value);
    return wrap(`${quoteIdent(column)} ${ARRAY_OPS[op]} $${values.length}::text[]`);
  }

  if (Object.prototype.hasOwnProperty.call(FILTER_OPS, op)) {
    if (value === null || value === undefined || Array.isArray(value)) {
      throw { code: "invalid_request", message: `filter op '${op}' needs a scalar value` };
    }
    values.push(value);
    return wrap(`${quoteIdent(column)} ${FILTER_OPS[op]} $${values.length}`);
  }

  throw { code: "invalid_request", message: `unknown filter op: ${String(op)}` };
}

/**
 * Validate + compile a filter list into a parameterized WHERE clause.
 *
 * Entries are ANDed. An entry may instead be `{ or: [[...], [...]] }`, whose
 * inner arrays are ANDed within themselves and ORed with each other, so
 * `{ or: [[a], [b]] }` is `((a) OR (b))`.
 *
 * Groups do NOT nest, deliberately. Every central `.or(...)` this replaces is
 * flat, and unbounded nesting would let one request build an arbitrarily deep
 * parse tree on a tenant box whose whole point is to be small and predictable.
 *
 * Returns the WHERE clause (or "") or throws { code, message }.
 */
function compileFilters(filters, values) {
  if (filters == null) return "";
  if (!Array.isArray(filters)) {
    throw { code: "invalid_request", message: "filters must be an array" };
  }
  const parts = [];
  for (const f of filters) {
    if (f != null && typeof f === "object" && Array.isArray(f.or)) {
      if (f.or.length === 0) {
        throw { code: "invalid_request", message: "filter group 'or' needs at least one branch" };
      }
      const branches = f.or.map((branch) => {
        if (!Array.isArray(branch) || branch.length === 0) {
          throw {
            code: "invalid_request",
            message: "each 'or' branch must be a non-empty array of conditions"
          };
        }
        if (branch.some((c) => c != null && typeof c === "object" && Array.isArray(c.or))) {
          throw { code: "invalid_request", message: "'or' groups do not nest" };
        }
        return branch.map((c) => compileCondition(c, values)).join(" AND ");
      });
      parts.push(`(${branches.map((b) => `(${b})`).join(" OR ")})`);
      continue;
    }
    parts.push(compileCondition(f, values));
  }
  return parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "";
}

export {
  ARRAY_OPS,
  assertColumns,
  compileCondition,
  compileFilters,
  FILTER_OPS,
  IDENT_RE,
  quoteIdent,
  SUPPORTED_FILTER_OPS
};
