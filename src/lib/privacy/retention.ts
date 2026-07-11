/**
 * Content-history retention pruning (security review G6).
 *
 * Deletes tenant CONTENT rows older than the admin-configured
 * `businesses.data_retention_days` window. The table set and predicates
 * mirror `residency_purge_business()` (20260805000000_residency_purge.sql)
 * — append-only history the engine never re-reads — with the same live-row
 * carve-outs (unread notifications, non-terminal calls/sends). Contacts
 * are deliberately EXEMPT: retention trims history, it does not erase
 * people; full per-person erasure is src/lib/privacy/deletion.ts.
 *
 * Residency interplay (the part that differs from the purge):
 *   * Central deletes here are REAL content deletes, so — unlike the purge
 *     — they must journal: the trigger replicates them to a dual/vps box as
 *     'delete' ops. No mute flag.
 *   * A vps-mode tenant's box holds history that central already purged, so
 *     central deletes alone can't enforce the window there. For dual/vps
 *     tenants the pruner ALSO deletes on the box through the data API. Box
 *     deletes overlap with the journaled ones — both are PK/filter deletes,
 *     idempotent, so the overlap is harmless.
 *   * A dual/vps box that is unreachable fails the tenant's prune loudly
 *     (recorded by the sweep); central rows already deleted stay deleted —
 *     re-running converges.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { DataApiClient } from "@/lib/residency/client";
import type { DataApiFilter } from "@/lib/residency/contract";
import type { ResidencyMovedTable } from "@/lib/residency/tables";
import { residencyModeFor } from "@/lib/residency/read";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type PruneTableResult = {
  table: string;
  /** Rows deleted centrally. */
  central: number;
  /** Rows deleted on the tenant box; null when the tenant has no box copy. */
  box: number | null;
};

export type PruneResult = {
  businessId: string;
  retentionDays: number;
  cutoffIso: string;
  tables: PruneTableResult[];
};

export type PruneDeps = {
  client?: SupabaseClient;
  /** Injectable data-api client factory (tests). */
  dataApiFor?: (businessId: string) => Pick<DataApiClient, "select" | "delete">;
  now?: () => Date;
};

/**
 * Terminal-state filters per pruned table, expressed once and translated to
 * both the central supabase-js query and the box data-api filters.
 */
const TERMINAL_CALL_STATUSES = ["completed", "errored", "missed"];
const TERMINAL_SMS_STATUSES = ["sent", "canceled", "failed"];

function centralCount(data: unknown): number {
  return Array.isArray(data) ? data.length : 0;
}

/* c8 ignore next 2 -- production default; tests inject dataApiFor */
const defaultDataApiFor = (businessId: string): Pick<DataApiClient, "select" | "delete"> =>
  new DataApiClient(businessId);

/**
 * Prune one tenant's expired content history. Throws on the first central
 * or box failure — the sweep records the error and re-runs tomorrow;
 * partial progress is safe because every delete is idempotent.
 */
export async function pruneExpiredContent(
  businessId: string,
  retentionDays: number,
  deps: PruneDeps = {}
): Promise<PruneResult> {
  const db = deps.client ?? (await createSupabaseServiceClient());
  const dataApiFor = deps.dataApiFor ?? defaultDataApiFor;
  const now = (deps.now ?? (() => new Date()))();
  const cutoffIso = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();

  const mode = await residencyModeFor(businessId, db);
  const boxed = mode === "dual" || mode === "vps";
  const api = boxed ? dataApiFor(businessId) : null;

  const results: PruneTableResult[] = [];

  const boxDelete = async (
    table: ResidencyMovedTable,
    filters: DataApiFilter[]
  ): Promise<number | null> => {
    if (!api) return null;
    const res = await api.delete({
      table,
      filters: [{ column: "business_id", op: "eq", value: businessId }, ...filters],
      returning: true
    });
    if (!res.ok) {
      throw new Error(`pruneExpiredContent: box delete on ${table} failed: ${res.message}`);
    }
    return res.rows.length;
  };

  // ── email_log ──────────────────────────────────────────────────────────
  {
    const { data, error } = await db
      .from("email_log")
      .delete()
      .eq("business_id", businessId)
      .lt("created_at", cutoffIso)
      .select("id");
    if (error) throw new Error(`pruneExpiredContent: email_log: ${error.message}`);
    results.push({
      table: "email_log",
      central: centralCount(data),
      box: await boxDelete("email_log", [{ column: "created_at", op: "lt", value: cutoffIso }])
    });
  }

  // ── sms_outbound_log ───────────────────────────────────────────────────
  {
    const { data, error } = await db
      .from("sms_outbound_log")
      .delete()
      .eq("business_id", businessId)
      .lt("created_at", cutoffIso)
      .select("id");
    if (error) throw new Error(`pruneExpiredContent: sms_outbound_log: ${error.message}`);
    results.push({
      table: "sms_outbound_log",
      central: centralCount(data),
      box: await boxDelete("sms_outbound_log", [
        { column: "created_at", op: "lt", value: cutoffIso }
      ])
    });
  }

  // ── voice_call_transcripts (+ turns) ───────────────────────────────────
  {
    // Terminal calls only; central turns follow via FK cascade. The box
    // schema has no FK, so turns are deleted explicitly by transcript id
    // BEFORE their parents.
    const { data, error } = await db
      .from("voice_call_transcripts")
      .delete()
      .eq("business_id", businessId)
      .lt("created_at", cutoffIso)
      .in("status", TERMINAL_CALL_STATUSES)
      .select("id");
    if (error) throw new Error(`pruneExpiredContent: voice_call_transcripts: ${error.message}`);

    let boxCount: number | null = null;
    if (api) {
      const expired = await api.select({
        table: "voice_call_transcripts",
        columns: ["id"],
        filters: [
          { column: "business_id", op: "eq", value: businessId },
          { column: "created_at", op: "lt", value: cutoffIso },
          { column: "status", op: "in", value: TERMINAL_CALL_STATUSES }
        ]
      });
      if (!expired.ok) {
        throw new Error(
          `pruneExpiredContent: box select on voice_call_transcripts failed: ${expired.message}`
        );
      }
      const ids = expired.rows.map((r) => String((r as { id: unknown }).id));
      if (ids.length > 0) {
        const turns = await api.delete({
          table: "voice_call_transcript_turns",
          filters: [{ column: "transcript_id", op: "in", value: ids }],
          returning: false
        });
        if (!turns.ok) {
          throw new Error(
            `pruneExpiredContent: box delete on voice_call_transcript_turns failed: ${turns.message}`
          );
        }
      }
      boxCount = await boxDelete("voice_call_transcripts", [
        { column: "created_at", op: "lt", value: cutoffIso },
        { column: "status", op: "in", value: TERMINAL_CALL_STATUSES }
      ]);
    }
    results.push({ table: "voice_call_transcripts", central: centralCount(data), box: boxCount });
  }

  // ── voice_outbound_dial_log ────────────────────────────────────────────
  {
    const { data, error } = await db
      .from("voice_outbound_dial_log")
      .delete()
      .eq("business_id", businessId)
      .lt("created_at", cutoffIso)
      .select("id");
    if (error) throw new Error(`pruneExpiredContent: voice_outbound_dial_log: ${error.message}`);
    results.push({
      table: "voice_outbound_dial_log",
      central: centralCount(data),
      box: await boxDelete("voice_outbound_dial_log", [
        { column: "created_at", op: "lt", value: cutoffIso }
      ])
    });
  }

  // ── notifications (read only — unread still drive the dashboard badge) ─
  {
    const { data, error } = await db
      .from("notifications")
      .delete()
      .eq("business_id", businessId)
      .lt("created_at", cutoffIso)
      .not("read_at", "is", null)
      .select("id");
    if (error) throw new Error(`pruneExpiredContent: notifications: ${error.message}`);
    results.push({
      table: "notifications",
      central: centralCount(data),
      // `read_at <= now` doubles as the non-null test — the data-api filter
      // grammar has no "is not null".
      box: await boxDelete("notifications", [
        { column: "created_at", op: "lt", value: cutoffIso },
        { column: "read_at", op: "lte", value: nowIso }
      ])
    });
  }

  // ── scheduled_sms (terminal only) ──────────────────────────────────────
  {
    const { data, error } = await db
      .from("scheduled_sms")
      .delete()
      .eq("business_id", businessId)
      .lt("send_at", cutoffIso)
      .in("status", TERMINAL_SMS_STATUSES)
      .select("id");
    if (error) throw new Error(`pruneExpiredContent: scheduled_sms: ${error.message}`);
    results.push({
      table: "scheduled_sms",
      central: centralCount(data),
      box: await boxDelete("scheduled_sms", [
        { column: "send_at", op: "lt", value: cutoffIso },
        { column: "status", op: "in", value: TERMINAL_SMS_STATUSES }
      ])
    });
  }

  // ── ai_reply_reasoning (central-only: not a residency-moved table) ─────
  {
    const { data, error } = await db
      .from("ai_reply_reasoning")
      .delete()
      .eq("business_id", businessId)
      .lt("created_at", cutoffIso)
      .select("id");
    if (error) throw new Error(`pruneExpiredContent: ai_reply_reasoning: ${error.message}`);
    results.push({ table: "ai_reply_reasoning", central: centralCount(data), box: null });
  }

  // ── business_document_shares (dead links only; central-only) ───────────
  // Share rows carry the recipient identifier (`shared_with` — PII). Only
  // rows whose link can no longer serve (revoked, or past the link's own
  // expiry) are pruned; a still-live link inside the retention window's
  // tail is an active capability the owner can see and revoke, not history.
  {
    const { data, error } = await db
      .from("business_document_shares")
      .delete()
      .eq("business_id", businessId)
      .lt("created_at", cutoffIso)
      .or(`expires_at.lt.${nowIso},revoked_at.not.is.null`)
      .select("id");
    if (error) throw new Error(`pruneExpiredContent: business_document_shares: ${error.message}`);
    results.push({ table: "business_document_shares", central: centralCount(data), box: null });
  }

  // ── sms_links (central-only: tracked short links carry the recipient ───
  // number + original URL; aged links go stale with their texts. Expired
  // codes then 303 to the homepage — by design).
  {
    const { data, error } = await db
      .from("sms_links")
      .delete()
      .eq("business_id", businessId)
      .lt("created_at", cutoffIso)
      .select("id");
    if (error) throw new Error(`pruneExpiredContent: sms_links: ${error.message}`);
    results.push({ table: "sms_links", central: centralCount(data), box: null });
  }

  // ── sms_owner_reply_prompts (answered only) ────────────────────────────
  {
    const { data, error } = await db
      .from("sms_owner_reply_prompts")
      .delete()
      .eq("business_id", businessId)
      .lt("created_at", cutoffIso)
      .not("answered_at", "is", null)
      .select("id");
    if (error) throw new Error(`pruneExpiredContent: sms_owner_reply_prompts: ${error.message}`);
    results.push({
      table: "sms_owner_reply_prompts",
      central: centralCount(data),
      box: await boxDelete("sms_owner_reply_prompts", [
        { column: "created_at", op: "lt", value: cutoffIso },
        { column: "answered_at", op: "lte", value: nowIso }
      ])
    });
  }

  const totalCentral = results.reduce((s, r) => s + r.central, 0);
  const totalBox = results.reduce((s, r) => s + (r.box ?? 0), 0);
  logger.info("pruneExpiredContent: done", {
    businessId,
    retentionDays,
    cutoffIso,
    totalCentral,
    totalBox,
    mode
  });

  return { businessId, retentionDays, cutoffIso, tables: results };
}
