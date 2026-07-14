/**
 * Residency-aware SOFT delete for owner-deletable content rows.
 *
 * Owner "delete" actions on content items (notifications, emails, call
 * transcripts, SMS sends, chat threads) stamp `deleted_at`/`deleted_by`
 * instead of removing the row: every owner-facing read filters the stamp
 * out, so the dashboard behaves exactly like a hard delete, while an admin
 * can still restore the row (/api/admin/deleted-items). Retention sweeps
 * and verified end-user erasure keep HARD-deleting regardless of the stamp,
 * so a soft delete never extends data lifetime.
 *
 * Residency interplay (mirrors src/lib/privacy/deletion.ts):
 *   * The central UPDATE journals normally, so a dual/vps box receives the
 *     stamp as a replicated upsert.
 *   * A vps-mode box also holds history central already purged, which the
 *     journal can't reach — so for dual/vps tenants the stamp is ALSO
 *     applied directly on the box through the data API. The overlap with
 *     the journaled update is idempotent (same stamp columns).
 *   * An unreachable dual/vps box fails the request loudly: reporting
 *     "deleted" while the box copy still serves the row to vps-mode reads
 *     would leave the item visible after a confirmed delete.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { DataApiClient } from "@/lib/residency/client";
import type { DataApiFilter } from "@/lib/residency/contract";
import type { ResidencyMovedTable } from "@/lib/residency/tables";
import { RESIDENCY_TABLE_PRIMARY_KEYS } from "@/lib/residency/tables";
import { residencyModeFor } from "@/lib/residency/read";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export class ContentRowMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentRowMutationError";
  }
}

/**
 * Row selector within the business scope. Deliberately narrower than the
 * data-api filter grammar: every owner delete targets rows by an exact
 * column value (id, call_control_id, to_e164, …) or an id set.
 */
export type ContentRowFilter = {
  column: string;
  op: "eq" | "in";
  value: string | string[];
};

export type ContentRowMutationResult = {
  /** Rows stamped centrally. */
  central: number;
  /** Rows stamped on the tenant box; null when the tenant has no box copy. */
  box: number | null;
};

export type ContentRowMutationDeps = {
  client?: SupabaseClient;
  /** Injectable data-api client factory (tests). */
  dataApiFor?: (businessId: string) => Pick<DataApiClient, "update">;
};

/* c8 ignore next 2 -- production default; tests inject dataApiFor */
const defaultDataApiFor = (businessId: string): Pick<DataApiClient, "update"> =>
  new DataApiClient(businessId);

async function stampContentRows(
  businessId: string,
  table: ResidencyMovedTable,
  filters: ContentRowFilter[],
  set: Record<string, string | null>,
  deps: ContentRowMutationDeps
): Promise<ContentRowMutationResult> {
  if (filters.length === 0) {
    // Belt-and-braces: business_id alone must never select a whole table.
    throw new ContentRowMutationError(`refusing to stamp ${table} with no row filters`);
  }
  const db = deps.client ?? (await createSupabaseServiceClient());
  const dataApiFor = deps.dataApiFor ?? defaultDataApiFor;

  // Central first: the journal replicates this stamp to a dual/vps box in
  // order, so even if the direct box call below fails, replay convergence
  // still delivers the stamp for rows central knows about.
  let q = db.from(table).update(set).eq("business_id", businessId);
  for (const f of filters) {
    q = f.op === "in" ? q.in(f.column, f.value as string[]) : q.eq(f.column, f.value as string);
  }
  const pk = RESIDENCY_TABLE_PRIMARY_KEYS[table][0];
  const { data, error } = await q.select(pk);
  if (error) {
    throw new ContentRowMutationError(`central update on ${table} failed: ${error.message}`);
  }
  const central = Array.isArray(data) ? data.length : 0;

  const mode = await residencyModeFor(businessId, db);
  if (mode !== "dual" && mode !== "vps") return { central, box: null };

  const api = dataApiFor(businessId);
  const boxFilters: DataApiFilter[] = [
    { column: "business_id", op: "eq", value: businessId },
    ...filters.map((f) => ({ column: f.column, op: f.op, value: f.value }))
  ];
  const res = await api.update({ table, set, filters: boxFilters, returning: true });
  if (!res.ok) {
    throw new ContentRowMutationError(`box update on ${table} failed: ${res.message}`);
  }
  return { central, box: res.rows.length };
}

/**
 * Soft-delete content rows (central + box). `deletedBy` is the auth user id
 * of the owner/staff member who clicked delete — audit trail only, never
 * shown to the tenant.
 */
export async function softDeleteContentRows(
  businessId: string,
  table: ResidencyMovedTable,
  filters: ContentRowFilter[],
  deletedBy: string | null,
  deps: ContentRowMutationDeps = {}
): Promise<ContentRowMutationResult> {
  return await stampContentRows(
    businessId,
    table,
    filters,
    { deleted_at: new Date().toISOString(), deleted_by: deletedBy },
    deps
  );
}

/**
 * Admin-only restore: clears the soft-delete stamp so the row reappears in
 * every owner-facing read (central + box).
 */
export async function restoreContentRows(
  businessId: string,
  table: ResidencyMovedTable,
  filters: ContentRowFilter[],
  deps: ContentRowMutationDeps = {}
): Promise<ContentRowMutationResult> {
  return await stampContentRows(
    businessId,
    table,
    filters,
    { deleted_at: null, deleted_by: null },
    deps
  );
}
