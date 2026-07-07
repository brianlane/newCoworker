/**
 * Wire contract for the per-tenant VPS data API (residency Phase 1+).
 *
 * The data API is a small service on the tenant's box, published through
 * their existing Cloudflare tunnel at `data-<businessId>.<zone>` and
 * fronting the box-local datastore that holds the RESIDENCY_MOVED_TABLES.
 * The dashboard `src/lib/db/*` modules and the Edge `_shared` helpers swap
 * their Supabase client for a client speaking this contract when the
 * tenant's `data_residency_mode` is 'dual' (writes) or 'vps' (reads +
 * writes) — call sites keep their query logic.
 *
 * Shape rationale: the platform's content queries are simple per-tenant
 * CRUD (equality/range filters, order, limit — no joins across moved
 * tables), so one generic filter-based endpoint per verb covers every
 * `src/lib/db/*` access pattern without inventing a per-table API surface
 * that would drift.
 *
 * Auth: every request carries `Authorization: Bearer <per-tenant gateway
 * token>` — the same token Rowboat calls already use (vps_gateway_tokens,
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

export type DataApiFilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "ilike"
  | "in"
  | "is";

export type DataApiFilter = {
  column: string;
  op: DataApiFilterOp;
  /** `is` accepts null; `in` accepts an array; everything else a scalar. */
  value: string | number | boolean | null | Array<string | number>;
};

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
  /** Refuses to run with no filters — no accidental full-table updates. */
  filters: DataApiFilter[];
  returning?: boolean;
};

/** POST /v1/delete */
export type DataApiDeleteRequest = {
  table: ResidencyMovedTable;
  /** Refuses to run with no filters — no accidental full-table deletes. */
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

/** GET /v1/health — unauthenticated liveness for tunnel/deploy probes. */
export type DataApiHealthResponse = {
  ok: boolean;
  /** Applied datastore schema revision (from the versioned DDL). */
  schemaVersion: string;
};

export function dataApiHostname(businessId: string, hostnameSuffix: string): string {
  return `${DATA_API_HOSTNAME_PREFIX}${businessId}.${hostnameSuffix}`;
}
