/**
 * Contacts CSV import/export (modeled on the BizBlasts /manage/csv surface).
 *
 * Export writes every column an owner could want back (including read-only
 * history columns); import recognizes only the owner-editable subset and
 * ignores everything else, so a previously exported file re-imports cleanly.
 *
 * Import semantics (row-by-row, never all-or-nothing):
 *   * `phone` is required and normalized like the Add-customer form
 *     (10-digit → +1…, `00`/`+` international, short codes allowed).
 *   * Existing contact (primary number OR merged-away alias) → update, but
 *     only with non-empty cells — a blank cell means "leave as is", never
 *     "clear". A CSV name is a deliberate label (name_source='manual').
 *   * No contact yet → create.
 *   * Bad rows are reported with their 1-based file row number and skipped;
 *     good rows still apply.
 *
 * Service-role only. Owner authorization is the API route's job
 * (requireOwner before any call here) — same trust model as customer-memory/db.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import {
  CONTACT_TYPES,
  SMS_REPLY_MODES,
  type ContactType,
  type CustomerMemoryRow,
  type SmsReplyMode
} from "@/lib/customer-memory/types";
import { PG_UNIQUE_VIOLATION } from "@/lib/customer-memory/db";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";
import { parseCsv, serializeCsv } from "./csv";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const MAX_IMPORT_ROWS = 2000;

export type CsvImportError = { row: number; message: string };

export type CsvImportSummary = {
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: CsvImportError[];
};

export const CONTACTS_EXPORT_HEADERS = [
  "phone",
  "name",
  "type",
  "email",
  "sms_reply_mode",
  "pinned_notes",
  "tags",
  "aliases",
  "last_channel",
  "last_interaction_at",
  "total_interactions",
  "created_at"
] as const;

const CONTACT_COLUMNS =
  "id,customer_e164,display_name,type,email,sms_reply_mode,pinned_md,tags," +
  "alias_e164s,last_channel,last_interaction_at,total_interaction_count,created_at";

type ExportRow = Pick<
  CustomerMemoryRow,
  | "id"
  | "customer_e164"
  | "display_name"
  | "type"
  | "email"
  | "sms_reply_mode"
  | "pinned_md"
  | "tags"
  | "alias_e164s"
  | "last_channel"
  | "last_interaction_at"
  | "total_interaction_count"
  | "created_at"
>;

const EXPORT_PAGE_SIZE = 1000;

/** Full contact directory as CSV text (paginated read, no row cap). */
export async function exportContactsCsv(
  businessId: string,
  client?: SupabaseClient
): Promise<string> {
  const db = client ?? (await createSupabaseServiceClient());
  const rows: ExportRow[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await db
      .from("contacts")
      .select(CONTACT_COLUMNS)
      .eq("business_id", businessId)
      .order("created_at", { ascending: true })
      .range(page * EXPORT_PAGE_SIZE, page * EXPORT_PAGE_SIZE + EXPORT_PAGE_SIZE - 1);
    if (error) throw new Error(`exportContactsCsv: ${error.message}`);
    const batch = (data ?? []) as unknown as ExportRow[];
    rows.push(...batch);
    if (batch.length < EXPORT_PAGE_SIZE) break;
  }
  return serializeCsv([
    [...CONTACTS_EXPORT_HEADERS],
    ...rows.map((r) => [
      r.customer_e164,
      r.display_name ?? "",
      r.type,
      r.email ?? "",
      r.sms_reply_mode,
      r.pinned_md ?? "",
      (r.tags ?? []).join(", "),
      (r.alias_e164s ?? []).join(" "),
      r.last_channel ?? "",
      r.last_interaction_at ?? "",
      r.total_interaction_count,
      r.created_at
    ])
  ]);
}

/** Header + one example row showing the importable columns. */
export function contactsCsvTemplate(): string {
  return serializeCsv([
    ["phone", "name", "type", "email", "sms_reply_mode", "pinned_notes"],
    [
      "+16025551234",
      "Jane Doe",
      "customer",
      "jane@example.com",
      "auto",
      "Prefers texts over calls"
    ]
  ]);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Import a contacts CSV. Applies row-by-row (good rows land even when others
 * fail) and returns the per-row outcome summary.
 */
export async function importContactsCsv(
  businessId: string,
  csvText: string,
  client?: SupabaseClient
): Promise<CsvImportSummary> {
  const summary: CsvImportSummary = {
    totalRows: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: []
  };
  const parsed = parseCsv(csvText);
  if (!parsed.ok) {
    summary.errors.push({ row: 0, message: parsed.error });
    return summary;
  }
  if (!parsed.headers.includes("phone")) {
    summary.errors.push({ row: 1, message: 'Missing required column: "phone".' });
    return summary;
  }
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    summary.errors.push({
      row: 0,
      message: `Too many rows (${parsed.rows.length}); the limit is ${MAX_IMPORT_ROWS} per file.`
    });
    return summary;
  }
  summary.totalRows = parsed.rows.length;
  const db = client ?? (await createSupabaseServiceClient());

  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    // 1-based file row: +1 for the header line, +1 for 0-index.
    const fileRow = i + 2;
    const normalized = normalizeContactNumber(row.phone);
    if (!normalized.ok) {
      summary.errors.push({ row: fileRow, message: `phone: ${normalized.reason}` });
      summary.skipped += 1;
      continue;
    }
    const phone = normalized.value;

    const name = (row.name ?? "").trim();
    const email = (row.email ?? "").trim();
    const type = (row.type ?? "").trim().toLowerCase();
    const replyMode = (row.sms_reply_mode ?? "").trim().toLowerCase();
    const pinned = (row.pinned_notes ?? "").trim();

    if (email && !EMAIL_RE.test(email)) {
      summary.errors.push({ row: fileRow, message: `email: "${email}" is not a valid address.` });
      summary.skipped += 1;
      continue;
    }
    if (type && !(CONTACT_TYPES as readonly string[]).includes(type)) {
      summary.errors.push({
        row: fileRow,
        message: `type: "${type}" is not one of ${CONTACT_TYPES.join(", ")}.`
      });
      summary.skipped += 1;
      continue;
    }
    if (replyMode && !(SMS_REPLY_MODES as readonly string[]).includes(replyMode)) {
      summary.errors.push({
        row: fileRow,
        message: `sms_reply_mode: "${replyMode}" is not one of ${SMS_REPLY_MODES.join(", ")}.`
      });
      summary.skipped += 1;
      continue;
    }

    try {
      // Only write cells the file actually provided — blank means keep.
      const patch: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
        ...(name ? { display_name: name, name_source: "manual" } : {}),
        ...(email ? { email } : {}),
        ...(type ? { type: type as ContactType } : {}),
        ...(replyMode ? { sms_reply_mode: replyMode as SmsReplyMode } : {}),
        ...(pinned ? { pinned_md: pinned } : {})
      };
      // Alias-aware update-by-phone so a merged-away number updates the
      // surviving profile instead of recreating the one the owner just merged.
      const applyUpdate = async (): Promise<boolean> => {
        const { data: existing, error: selErr } = await db
          .from("contacts")
          .select("id")
          .eq("business_id", businessId)
          .or(`customer_e164.eq.${phone},alias_e164s.cs.{${phone}}`)
          .maybeSingle();
        if (selErr) throw new Error(selErr.message);
        if (!existing) return false;
        const { error: updErr } = await db.from("contacts").update(patch).eq("id", existing.id);
        if (updErr) throw new Error(updErr.message);
        return true;
      };

      if (await applyUpdate()) {
        summary.updated += 1;
      } else {
        const { error: insErr } = await db.from("contacts").insert({
          business_id: businessId,
          customer_e164: phone,
          display_name: name || null,
          ...(name ? { name_source: "manual" } : {}),
          email: email || null,
          ...(type ? { type: type as ContactType } : {}),
          ...(replyMode ? { sms_reply_mode: replyMode as SmsReplyMode } : {}),
          pinned_md: pinned || null
        });
        if (insErr) {
          if (insErr.code !== PG_UNIQUE_VIOLATION) throw new Error(insErr.message);
          // Raced by a concurrent auto-create (inbound SMS/call) between the
          // lookup and the insert: the profile exists now, so apply the row's
          // fields as an update rather than dropping them.
          if (await applyUpdate()) {
            summary.updated += 1;
          } else {
            // The racing row vanished again (e.g. concurrent delete/merge) —
            // report it instead of silently losing the row's data.
            throw new Error(`A concurrent change kept ${phone} from being saved; re-import this row.`);
          }
        } else {
          summary.created += 1;
          // contact_created triggers: an import-created contact may start
          // flows watching for new contacts (drip pacing spaces bulk
          // enrollments out). Best-effort inside fireContactEvent — a
          // trigger failure never fails the row.
          await fireContactEvent(businessId, {
            kind: "contact_created",
            contact: {
              e164: phone,
              ...(name ? { name } : {}),
              ...(email ? { email } : {})
            },
            dedupeKey: `ce:created:${businessId}:${phone}`
          });
        }
      }
    } catch (e) {
      summary.errors.push({
        row: fileRow,
        message: e instanceof Error ? e.message : "Unexpected error"
      });
      summary.skipped += 1;
    }
  }
  return summary;
}
