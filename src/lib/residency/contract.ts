/**
 * Wire contract for the per-tenant VPS data API (residency Phase 1+).
 *
 * The data API is a small service on the tenant's box, published through
 * their existing Cloudflare tunnel at `data-<businessId>.<zone>` and
 * fronting the box-local datastore that holds the RESIDENCY_MOVED_TABLES.
 * The dashboard `src/lib/db/*` modules and the Edge `_shared` helpers swap
 * their Supabase client for a client speaking this contract when the
 * tenant's `data_residency_mode` is 'dual' (writes) or 'vps' (reads +
 * writes), call sites keep their query logic.
 *
 * Shape rationale: the platform's content queries are simple per-tenant
 * CRUD (equality/range filters, order, limit, no joins across moved
 * tables), so one generic filter-based endpoint per verb covers every
 * `src/lib/db/*` access pattern without inventing a per-table API surface
 * that would drift.
 *
 * Auth: every request carries `Authorization: Bearer <per-tenant gateway
 * token>`, the same token Rowboat calls already use (vps_gateway_tokens,
 * sha256-indexed, centrally revocable). The service must validate with a
 * timing-safe compare and accept every non-revoked token for the tenant so
 * the deploy/rotation overlap window (pending vs confirmed tokens) never
 * drops requests.
 */

import type { ResidencyMovedTable } from "@/lib/residency/tables";

/** All requests are JSON POSTs under this prefix (plus GET /v1/health). */
export const DATA_API_PREFIX = "/v1";

/** Hostname prefix on the tenant tunnel, alongside `voice-` / `render-`. */
export const DATA_API_HOSTNAME_PREFIX = "data-";

/**
 * Runtime list, so the box's own copy can be lockstep-tested against it
 * (vps/data-api/server.mjs has no build step against this repo). The type is
 * derived from the list rather than written twice.
 */
export const DATA_API_FILTER_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "in",
  "is",
  /** Array containment, `col @> value[]`, for text[] columns. */
  "contains",
  /** Array overlap, `col && value[]`, for text[] columns. */
  "overlaps"
] as const;

export type DataApiFilterOp = (typeof DATA_API_FILTER_OPS)[number];

export type DataApiFilterCondition = {
  column: string;
  op: DataApiFilterOp;
  /**
   * `is` accepts null; `in`, `contains` and `overlaps` accept an array;
   * everything else a scalar.
   */
  value: string | number | boolean | null | Array<string | number>;
  /**
   * Negate this condition. `{ op: "is", value: null, negate: true }` is the
   * only way to express IS NOT NULL, which PostgREST callers write as
   * `.not(col, "is", null)` and which the grammar previously could not say
   * at all.
   */
  negate?: boolean;
};

/**
 * A disjunction. The inner arrays are ANDed within themselves and ORed with
 * each other, so `{ or: [[a], [b]] }` is `(a) OR (b)`.
 *
 * ONE LEVEL ONLY, deliberately: a group may not contain another group. Every
 * central query this replaces is a flat `.or("a,b")`, and unbounded nesting
 * would let a caller build an arbitrarily deep parse tree on a tenant box
 * whose whole point is to be small and predictable.
 */
export type DataApiFilterGroup = {
  or: DataApiFilterCondition[][];
};

export type DataApiFilter = DataApiFilterCondition | DataApiFilterGroup;


export type DataApiOrder = {
  column: string;
  ascending: boolean;
  /**
   * Explicit NULLS placement. Omitted = PostgreSQL defaults (NULLS FIRST on
   * DESC, NULLS LAST on ASC). Central call sites that use supabase-js
   * `nullsFirst:` must pass this so box ordering matches central exactly.
   */
  nullsFirst?: boolean;
};

/** POST /v1/select */
export type DataApiSelectRequest = {
  table: ResidencyMovedTable;
  /** Column projection; omitted = all columns. */
  columns?: string[];
  filters?: DataApiFilter[];
  order?: DataApiOrder[];
  limit?: number;
  offset?: number;
  /** Return a total row count alongside the page (COUNT over the filters). */
  count?: boolean;
};

/** POST /v1/insert */
export type DataApiInsertRequest = {
  table: ResidencyMovedTable;
  rows: Array<Record<string, unknown>>;
  /**
   * Column set for ON CONFLICT upsert semantics; omitted = plain insert.
   * Mirrors supabase-js `.upsert(..., { onConflict })`.
   */
  onConflict?: string[];
  /** Return the written rows (RETURNING *). */
  returning?: boolean;
};

/** POST /v1/update */
export type DataApiUpdateRequest = {
  table: ResidencyMovedTable;
  set: Record<string, unknown>;
  /** Refuses to run with no filters, no accidental full-table updates. */
  filters: DataApiFilter[];
  returning?: boolean;
};

/** POST /v1/delete */
export type DataApiDeleteRequest = {
  table: ResidencyMovedTable;
  /** Refuses to run with no filters, no accidental full-table deletes. */
  filters: DataApiFilter[];
  returning?: boolean;
};

export type DataApiErrorCode =
  | "unauthorized"
  | "unknown_table"
  | "invalid_request"
  | "conflict"
  | "internal";

export type DataApiResponse<Row = Record<string, unknown>> =
  | {
      ok: true;
      rows: Row[];
      /** Present when the request asked for `count: true`. */
      count?: number;
    }
  | {
      ok: false;
      error: DataApiErrorCode;
      message: string;
    };

/** GET /v1/health, unauthenticated liveness for tunnel/deploy probes. */
export type DataApiHealthResponse = {
  ok: boolean;
  /** Applied datastore schema revision (from the versioned DDL). */
  schemaVersion: string;
  /**
   * Filter ops this box understands, and whether it can compile OR groups.
   * Absent on a box deployed before the grammar widened, which is exactly
   * what makes it useful: `debug/residency-parity.ts` can refuse to pass a
   * tenant whose box cannot speak what the code now sends, instead of
   * discovering it on the first dashboard read after the flip.
   */
  ops?: string[];
  orGroups?: boolean;
};

export function dataApiHostname(businessId: string, hostnameSuffix: string): string {
  return `${DATA_API_HOSTNAME_PREFIX}${businessId}.${hostnameSuffix}`;
}
