/**
 * Admin view + restore for owner-soft-deleted content.
 *
 * Owners "delete" notifications, emails, calls, SMS conversations, and chat
 * threads with a `deleted_at` stamp (see src/lib/residency/row-delete.ts);
 * this module is the ONLY surface that reads those stamped rows back —
 * newest first, summarized enough for an admin to identify — and clears the
 * stamp on request. Restore is deliberately admin-only: the owner-facing
 * dashboard behaves as if the delete were hard.
 *
 * Residency: reads follow the same routing as the dashboard (vps-mode
 * tenants read their box, everyone else central) so box-only rows that
 * central already purged still show up. Restores go through
 * restoreContentRows (central + box) for moved tables;
 * `sms_inbound_jobs` is a central-only engine table and is updated
 * directly.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { isVpsReadMode, readMovedRows, type ReadDeps } from "@/lib/residency/read";
import {
  restoreContentRows,
  type ContentRowMutationDeps
} from "@/lib/residency/row-delete";
import type { ResidencyMovedTable } from "@/lib/residency/tables";
import { customerE164FromPayload } from "@/lib/db/sms-history";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type DeletedItemType =
  | "notification"
  | "email"
  | "call"
  | "sms_conversation"
  | "chat_thread";

export type DeletedItem = {
  type: DeletedItemType;
  /** Row id — or the customer number for a grouped SMS conversation. */
  id: string;
  /** Human-readable identification line for the admin card. */
  summary: string;
  deletedAt: string;
  /** Auth user id of whoever clicked delete (audit only). */
  deletedBy: string | null;
  /** Rows behind a grouped item (SMS conversations). */
  rowCount: number;
};

export type DeletedItemsDeps = ContentRowMutationDeps & ReadDeps;

/** Per-table listing cap — the admin card shows recent deletes, not an archive. */
const PER_TABLE_LIMIT = 100;

/**
 * The data-api filter grammar has no "is not null" op; for timestamptz a
 * `gt` epoch compare selects exactly the stamped rows.
 */
const EPOCH_ISO = "1970-01-01T00:00:00Z";

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

async function readDeletedRows(
  businessId: string,
  table: ResidencyMovedTable,
  columns: string[],
  vps: boolean,
  db: SupabaseClient,
  deps: DeletedItemsDeps
): Promise<Row[]> {
  if (vps) {
    return await readMovedRows<Row>(
      businessId,
      {
        table,
        columns,
        filters: [
          { column: "business_id", op: "eq", value: businessId },
          { column: "deleted_at", op: "gt", value: EPOCH_ISO }
        ],
        order: [{ column: "deleted_at", ascending: false }],
        limit: PER_TABLE_LIMIT
      },
      deps
    );
  }
  const { data, error } = await db
    .from(table)
    .select(columns.join(", "))
    .eq("business_id", businessId)
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false })
    .limit(PER_TABLE_LIMIT);
  if (error) throw new Error(`listDeletedItems(${table}): ${error.message}`);
  return (data as unknown as Row[] | null) ?? [];
}

/**
 * Every soft-deleted item for one business, newest deletion first. SMS rows
 * (outbound sends + inbound jobs) are folded into one entry per customer
 * number — that matches the owner's delete unit ("delete conversation") and
 * gives the admin a single restore action instead of hundreds.
 */
export async function listDeletedItems(
  businessId: string,
  deps: DeletedItemsDeps = {}
): Promise<DeletedItem[]> {
  const db = deps.client ?? (await createSupabaseServiceClient());
  const vps = await isVpsReadMode(businessId, db);

  const [notifications, emails, calls, threads, outboundSms] = await Promise.all([
    readDeletedRows(
      businessId,
      "notifications",
      ["id", "summary", "kind", "created_at", "deleted_at", "deleted_by"],
      vps,
      db,
      deps
    ),
    readDeletedRows(
      businessId,
      "email_log",
      ["id", "direction", "subject", "to_email", "from_email", "deleted_at", "deleted_by"],
      vps,
      db,
      deps
    ),
    readDeletedRows(
      businessId,
      "voice_call_transcripts",
      ["id", "caller_e164", "direction", "status", "started_at", "deleted_at", "deleted_by"],
      vps,
      db,
      deps
    ),
    // Chat is engine state — reads stay central in every residency mode,
    // mirroring src/lib/db/dashboard-chat.ts.
    readDeletedRows(
      businessId,
      "dashboard_chat_threads",
      ["id", "title", "deleted_at", "deleted_by"],
      false,
      db,
      deps
    ),
    readDeletedRows(
      businessId,
      "sms_outbound_log",
      ["id", "to_e164", "deleted_at", "deleted_by"],
      vps,
      db,
      deps
    )
  ]);

  // Inbound jobs are central-only. `payload` rides along so legacy rows
  // (customer_e164 NULL — the delete stamped them by payload matching) can
  // still be folded into their conversation below.
  const { data: inboundData, error: inboundError } = await db
    .from("sms_inbound_jobs")
    .select("id, customer_e164, payload, deleted_at, deleted_by")
    .eq("business_id", businessId)
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false })
    .limit(PER_TABLE_LIMIT);
  if (inboundError) {
    throw new Error(`listDeletedItems(sms_inbound_jobs): ${inboundError.message}`);
  }
  const inboundSms = (inboundData as unknown as Row[] | null) ?? [];

  const items: DeletedItem[] = [];

  for (const n of notifications) {
    items.push({
      type: "notification",
      id: String(n.id),
      summary: str(n.summary) ?? str(n.kind) ?? "Notification",
      deletedAt: String(n.deleted_at),
      deletedBy: str(n.deleted_by),
      rowCount: 1
    });
  }
  for (const e of emails) {
    const other = e.direction === "inbound" ? str(e.from_email) : str(e.to_email);
    items.push({
      type: "email",
      id: String(e.id),
      summary: `${e.direction === "inbound" ? "Received" : "Sent"} email: ${
        str(e.subject) ?? "(no subject)"
      }${other ? ` — ${other}` : ""}`,
      deletedAt: String(e.deleted_at),
      deletedBy: str(e.deleted_by),
      rowCount: 1
    });
  }
  for (const c of calls) {
    items.push({
      type: "call",
      id: String(c.id),
      summary: `${c.direction === "outbound" ? "Outbound" : "Inbound"} call ${
        str(c.caller_e164) ? `with ${c.caller_e164}` : "(unknown caller)"
      } · ${str(c.status) ?? "unknown"}${
        str(c.started_at) ? ` · ${String(c.started_at).slice(0, 10)}` : ""
      }`,
      deletedAt: String(c.deleted_at),
      deletedBy: str(c.deleted_by),
      rowCount: 1
    });
  }
  for (const t of threads) {
    items.push({
      type: "chat_thread",
      id: String(t.id),
      summary: `Chat: ${str(t.title) ?? "Untitled conversation"}`,
      deletedAt: String(t.deleted_at),
      deletedBy: str(t.deleted_by),
      rowCount: 1
    });
  }

  // Fold SMS rows into one conversation entry per number.
  const conversations = new Map<string, { deletedAt: string; deletedBy: string | null; count: number }>();
  const foldSms = (e164: string | null, deletedAt: string, deletedBy: string | null): void => {
    if (!e164) return;
    const existing = conversations.get(e164);
    if (!existing) {
      conversations.set(e164, { deletedAt, deletedBy, count: 1 });
      return;
    }
    existing.count += 1;
    if (deletedAt > existing.deletedAt) {
      existing.deletedAt = deletedAt;
      existing.deletedBy = deletedBy;
    }
  };
  for (const o of outboundSms) foldSms(str(o.to_e164), String(o.deleted_at), str(o.deleted_by));
  for (const j of inboundSms) {
    // Legacy rows predate the denormalized column — identify them the same
    // way the reader and the delete did, by parsing the Telnyx payload.
    const e164 =
      str(j.customer_e164) ??
      customerE164FromPayload(j.payload as Record<string, unknown> | null);
    foldSms(e164, String(j.deleted_at), str(j.deleted_by));
  }
  for (const [e164, agg] of conversations) {
    items.push({
      type: "sms_conversation",
      id: e164,
      summary: `SMS conversation with ${e164} (${agg.count} message${agg.count === 1 ? "" : "s"})`,
      deletedAt: agg.deletedAt,
      deletedBy: agg.deletedBy,
      rowCount: agg.count
    });
  }

  return items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
}

/**
 * Clear the soft-delete stamp so the item reappears in the owner's
 * dashboard (central + box for moved tables). A restored chat thread comes
 * back ARCHIVED (is_active stays false) — it shows in history without
 * displacing the owner's current conversation. Returns the number of rows
 * un-stamped (0 = nothing matched; idempotent).
 */
export async function restoreDeletedItem(
  businessId: string,
  type: DeletedItemType,
  id: string,
  deps: DeletedItemsDeps = {}
): Promise<{ restored: number }> {
  const db = deps.client ?? (await createSupabaseServiceClient());
  const mutationDeps: ContentRowMutationDeps = {
    client: db,
    ...(deps.dataApiFor ? { dataApiFor: deps.dataApiFor } : {})
  };

  const byId = async (table: ResidencyMovedTable): Promise<number> => {
    const result = await restoreContentRows(
      businessId,
      table,
      [{ column: "id", op: "eq", value: id }],
      mutationDeps
    );
    return Math.max(result.central, result.box ?? 0);
  };

  switch (type) {
    case "notification":
      return { restored: await byId("notifications") };
    case "email":
      return { restored: await byId("email_log") };
    case "call":
      return { restored: await byId("voice_call_transcripts") };
    case "chat_thread":
      return { restored: await byId("dashboard_chat_threads") };
    case "sms_conversation": {
      // Outbound sends (residency-aware) …
      const outbound = await restoreContentRows(
        businessId,
        "sms_outbound_log",
        [{ column: "to_e164", op: "eq", value: id }],
        mutationDeps
      );
      // … plus the central-only inbound jobs.
      const { data, error } = await db
        .from("sms_inbound_jobs")
        .update({ deleted_at: null, deleted_by: null })
        .eq("business_id", businessId)
        .eq("customer_e164", id)
        .not("deleted_at", "is", null)
        .select("id");
      if (error) throw new Error(`restoreDeletedItem(sms_inbound_jobs): ${error.message}`);
      let inbound = Array.isArray(data) ? data.length : 0;

      // Rows the delete stamped by PAYLOAD matching (legacy NULL columns, or
      // a column value that diverged from the payload) are restored the same
      // way — page every still-stamped row, match payloads, un-stamp by id.
      const PAGE = 500;
      const legacyIds: string[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const { data: page, error: pageError } = await db
          .from("sms_inbound_jobs")
          .select("id, payload")
          .eq("business_id", businessId)
          .not("deleted_at", "is", null)
          .order("id", { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (pageError) {
          throw new Error(`restoreDeletedItem(sms_inbound_jobs legacy): ${pageError.message}`);
        }
        const rows =
          (page as unknown as Array<{ id: string; payload: Record<string, unknown> }> | null) ??
          [];
        for (const row of rows) {
          if (customerE164FromPayload(row.payload) === id) legacyIds.push(row.id);
        }
        if (rows.length < PAGE) break;
      }
      if (legacyIds.length > 0) {
        const { data: legacyData, error: legacyError } = await db
          .from("sms_inbound_jobs")
          .update({ deleted_at: null, deleted_by: null })
          .eq("business_id", businessId)
          .in("id", legacyIds)
          .select("id");
        if (legacyError) {
          throw new Error(`restoreDeletedItem(sms_inbound_jobs legacy): ${legacyError.message}`);
        }
        inbound += Array.isArray(legacyData) ? legacyData.length : 0;
      }
      return { restored: Math.max(outbound.central, outbound.box ?? 0) + inbound };
    }
  }
}
