/**
 * Residency journal replayer (Phase B2).
 *
 * Drains `residency_write_journal` to each opted-in tenant's box-local data
 * API, strictly in `seq` order per business. Invoked every minute by
 * pg_cron → Edge `residency-replay` → POST /api/internal/residency-replay.
 *
 * Worst-case posture (the design brief for the whole residency program):
 *   * A down box does NOT block anything else: the drain is per-business
 *     and a failure only stops THAT business's queue. The journal keeps
 *     absorbing writes; the next run resumes at the same row.
 *   * Ordering is sacred: on the first failing row/batch the business's
 *     drain STOPS. Skipping ahead could replay a delete before its insert
 *     or an old update over a newer one.
 *   * Confirmed rows are DELETED — central Supabase holds residency
 *     content in transit only, never at rest in the journal.
 *   * A tenant flipped back to 'supabase' mode gets pending rows marked
 *     skipped (audited via last_error) instead of replayed — the box is no
 *     longer authoritative and must not keep receiving writes.
 *   * Every batch is capped and the whole run is bounded, so a huge
 *     backlog degrades to "multiple runs", never to an unbounded request.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { DataApiClient, DataApiTransportError } from "@/lib/residency/client";
import {
  RESIDENCY_TABLE_PRIMARY_KEYS,
  isResidencyMovedTable,
  type ResidencyMovedTable
} from "@/lib/residency/tables";
import type { DataApiFilter } from "@/lib/residency/contract";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type JournalRow = {
  seq: number;
  business_id: string;
  table_name: string;
  op: "upsert" | "delete";
  payload: Record<string, unknown>;
  attempts: number;
};

export type ReplayBusinessResult = {
  businessId: string;
  replayed: number;
  skipped: number;
  /** Set when the drain stopped early (box down, bad row, …). */
  stoppedAt?: number;
  error?: string;
};

export type ReplaySummary = {
  businesses: ReplayBusinessResult[];
  totalReplayed: number;
  totalSkipped: number;
  totalErrors: number;
};

export type ReplayDeps = {
  client?: SupabaseClient;
  /** Injectable for tests / smoke against a port-forwarded box. */
  makeDataApi?: (businessId: string) => DataApiClient;
  /** Max journal rows drained per business per run. */
  perBusinessLimit?: number;
  /** Max businesses processed per run. */
  businessLimit?: number;
  /** Max rows per data-api upsert batch. */
  batchSize?: number;
};

/** Consecutive same-table upserts collapse into one batched insert call. */
export function chunkJournalRows(rows: JournalRow[], batchSize: number): JournalRow[][] {
  const chunks: JournalRow[][] = [];
  for (const row of rows) {
    const current = chunks[chunks.length - 1];
    if (
      current &&
      current.length < batchSize &&
      row.op === "upsert" &&
      current[0].op === "upsert" &&
      current[0].table_name === row.table_name
    ) {
      current.push(row);
    } else {
      chunks.push([row]);
    }
  }
  return chunks;
}

/** PK equality filters for a delete row's payload. */
export function deleteFiltersFor(
  table: ResidencyMovedTable,
  payload: Record<string, unknown>
): DataApiFilter[] {
  return RESIDENCY_TABLE_PRIMARY_KEYS[table].map((column) => {
    const value = payload[column];
    if (value === null || value === undefined) {
      throw new Error(`journal delete for ${table} is missing PK column ${column}`);
    }
    return { column, op: "eq" as const, value: value as string | number };
  });
}

/**
 * Upserts can carry columns the payload rows don't share with each other
 * (schema drift between journal time and now is impossible within one batch
 * — the trigger snapshots full row images — but defensive normalization
 * keeps the batch insert well-formed if a migration lands mid-backlog).
 */
export function normalizeBatchColumns(
  rows: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const columns = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) columns.add(key);
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const column of columns) out[column] = row[column] ?? null;
    return out;
  });
}

async function markBatchFailed(
  db: SupabaseClient,
  rows: JournalRow[],
  message: string
): Promise<void> {
  const { error } = await db
    .from("residency_write_journal")
    .update({ last_error: message.slice(0, 2000) })
    .in(
      "seq",
      rows.map((r) => r.seq)
    );
  if (error) {
    logger.warn("residency-replay: failed to record batch error", {
      seqs: rows.map((r) => r.seq),
      error: error.message
    });
  }
  // attempts is bumped separately via rpc-free arithmetic: read-modify-write
  // per row would race with nothing (single replayer via cron), but keep it
  // one statement anyway.
  const { error: bumpError } = await db.rpc("residency_bump_attempts", {
    p_seqs: rows.map((r) => r.seq)
  });
  if (bumpError) {
    logger.warn("residency-replay: attempts bump failed", { error: bumpError.message });
  }
}

async function deleteReplayed(db: SupabaseClient, rows: JournalRow[]): Promise<void> {
  const { error } = await db
    .from("residency_write_journal")
    .delete()
    .in(
      "seq",
      rows.map((r) => r.seq)
    );
  if (error) throw new Error(`residency-replay: journal delete failed: ${error.message}`);
}

async function drainBusiness(
  db: SupabaseClient,
  api: DataApiClient,
  businessId: string,
  perBusinessLimit: number,
  batchSize: number
): Promise<ReplayBusinessResult> {
  const result: ReplayBusinessResult = { businessId, replayed: 0, skipped: 0 };

  // Mode re-check: a tenant rolled back to central must stop receiving
  // replicated writes immediately — pending rows are marked skipped, kept
  // nowhere (deleted) since central remains the source of truth anyway.
  const { data: biz, error: bizError } = await db
    .from("businesses")
    .select("tier, data_residency_mode")
    .eq("id", businessId)
    .maybeSingle();
  if (bizError) {
    result.error = `business lookup failed: ${bizError.message}`;
    return result;
  }
  const mode = (biz as { data_residency_mode?: string } | null)?.data_residency_mode ?? "supabase";
  if (mode === "supabase") {
    const { data: skippedRows, error: skipError } = await db
      .from("residency_write_journal")
      .delete()
      .eq("business_id", businessId)
      .is("replayed_at", null)
      .select("seq");
    if (skipError) {
      result.error = `skip-on-rollback failed: ${skipError.message}`;
      return result;
    }
    result.skipped = (skippedRows ?? []).length;
    return result;
  }

  const { data: pending, error: pendingError } = await db
    .from("residency_write_journal")
    .select("seq, business_id, table_name, op, payload, attempts")
    .eq("business_id", businessId)
    .is("replayed_at", null)
    .order("seq", { ascending: true })
    .limit(perBusinessLimit);
  if (pendingError) {
    result.error = `pending fetch failed: ${pendingError.message}`;
    return result;
  }

  const rows = (pending ?? []) as JournalRow[];
  for (const chunk of chunkJournalRows(rows, batchSize)) {
    const table = chunk[0].table_name;
    if (!isResidencyMovedTable(table)) {
      // A journal row for a table the box does not host can never replay;
      // stopping here would wedge the business forever, so record + stop
      // loudly — this indicates a trigger/inventory mismatch that needs a
      // human (it cannot happen while the migration and tables.ts agree).
      await markBatchFailed(db, chunk, `unknown moved table: ${table}`);
      result.stoppedAt = chunk[0].seq;
      result.error = `unknown moved table: ${table}`;
      return result;
    }
    try {
      if (chunk[0].op === "upsert") {
        const res = await api.insert({
          table,
          rows: normalizeBatchColumns(chunk.map((r) => r.payload)),
          onConflict: [...RESIDENCY_TABLE_PRIMARY_KEYS[table]],
          returning: false
        });
        if (!res.ok) {
          await markBatchFailed(db, chunk, `${res.error}: ${res.message}`);
          result.stoppedAt = chunk[0].seq;
          result.error = `${res.error}: ${res.message}`;
          return result;
        }
      } else {
        const res = await api.delete({
          table,
          filters: deleteFiltersFor(table, chunk[0].payload),
          returning: false
        });
        if (!res.ok) {
          await markBatchFailed(db, chunk, `${res.error}: ${res.message}`);
          result.stoppedAt = chunk[0].seq;
          result.error = `${res.error}: ${res.message}`;
          return result;
        }
      }
    } catch (err) {
      const message =
        err instanceof DataApiTransportError || err instanceof Error
          ? err.message
          : String(err);
      await markBatchFailed(db, chunk, message);
      result.stoppedAt = chunk[0].seq;
      result.error = message;
      return result;
    }
    await deleteReplayed(db, chunk);
    result.replayed += chunk.length;
  }

  return result;
}

export async function runResidencyReplay(deps: ReplayDeps = {}): Promise<ReplaySummary> {
  const db = deps.client ?? (await createSupabaseServiceClient());
  const makeDataApi = deps.makeDataApi ?? ((businessId: string) => new DataApiClient(businessId));
  const perBusinessLimit = deps.perBusinessLimit ?? 500;
  const businessLimit = deps.businessLimit ?? 20;
  const batchSize = deps.batchSize ?? 100;

  const { data: pendingBusinesses, error } = await db.rpc("residency_pending_businesses");
  if (error) throw new Error(`residency-replay: pending businesses rpc failed: ${error.message}`);

  const summary: ReplaySummary = {
    businesses: [],
    totalReplayed: 0,
    totalSkipped: 0,
    totalErrors: 0
  };

  const ids = ((pendingBusinesses ?? []) as string[]).slice(0, businessLimit);
  for (const businessId of ids) {
    const result = await drainBusiness(
      db,
      makeDataApi(businessId),
      businessId,
      perBusinessLimit,
      batchSize
    );
    summary.businesses.push(result);
    summary.totalReplayed += result.replayed;
    summary.totalSkipped += result.skipped;
    if (result.error) {
      summary.totalErrors += 1;
      logger.warn("residency-replay: business drain stopped", {
        businessId,
        stoppedAt: result.stoppedAt ?? null,
        error: result.error
      });
    }
  }

  return summary;
}
