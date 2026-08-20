/**
 * Contacts CSV import/export (modeled on the BizBlasts /manage/csv surface).
 *
 * Export writes every column an owner could want back (including read-only
 * history columns); import recognizes only the owner-editable subset and
 * ignores everything else, so a previously exported file re-imports cleanly.
 *
 * Import semantics (row-by-row, never all-or-nothing):
 *   * A row is identified by `phone` OR `email`. `phone` is normalized like
 *     the Add-customer form (10-digit → +1…, `00`/`+` international, short
 *     codes allowed). A row with no usable number but a valid address is keyed
 *     by that address instead, which is also how a previously EXPORTED
 *     email-keyed contact round-trips (its `phone` cell holds the `email:` key).
 *   * Existing contact (primary number OR merged-away alias) → update, but
 *     only with non-empty cells, a blank cell means "leave as is", never
 *     "clear". A CSV name is a deliberate label (name_source='manual').
 *   * New phone whose EMAIL matches exactly ONE existing customer profile →
 *     the same person's second number (CustomerLinker-style email
 *     cross-conflict resolution): the existing profile is updated and the
 *     new number is recorded in its alias_e164s, so texts/calls from it
 *     resolve to that profile instead of forking a duplicate person.
 *     Ambiguous emails (2+ matches) or non-customer matches fall through
 *     to a plain create.
 *   * No contact yet → create.
 *   * Bad rows are reported with their 1-based file row number and skipped;
 *     good rows still apply.
 *
 * Service-role only. Owner authorization is the API route's job
 * (requireOwner before any call here), same trust model as customer-memory/db.
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
import { escapeLikeLiteral } from "@/lib/privacy/deletion";
import {
  contactAliasOrFilter,
  contactKeyEmail,
  emailContactKey,
  isEmailContactKey
} from "../../../supabase/functions/_shared/contact_key";
import { parseCsv, serializeCsv } from "./csv";
import { CONTACTS_EXPORT_HEADERS } from "./contacts-export-shape";

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

// Column contract shared with the client-side selected-rows export; the
// list lives in contacts-export-shape.ts (client-safe, no service client)
// and is re-exported here for the server-side consumers.
export { CONTACTS_EXPORT_HEADERS };

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

/**
 * Header + example rows showing the importable columns. Two rows, because the
 * second one is the discoverable part: a contact identified only by an email
 * address, with the phone cell left blank.
 */
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
    ],
    ["", "Sam Okoye", "customer", "sam@example.com", "auto", "Email only, no number yet"]
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
  // Either identity column is enough. A file with only addresses is the shape
  // a lead source exports when it never had numbers to give.
  if (!parsed.headers.includes("phone") && !parsed.headers.includes("email")) {
    summary.errors.push({ row: 1, message: 'Missing required column: "phone" or "email".' });
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
    const name = (row.name ?? "").trim();
    const email = (row.email ?? "").trim();
    const type = (row.type ?? "").trim().toLowerCase();
    const replyMode = (row.sms_reply_mode ?? "").trim().toLowerCase();
    const pinned = (row.pinned_notes ?? "").trim();

    // Address validation runs FIRST because the address can be the row's
    // identity, not just one of its fields.
    if (email && !EMAIL_RE.test(email)) {
      summary.errors.push({ row: fileRow, message: `email: "${email}" is not a valid address.` });
      summary.skipped += 1;
      continue;
    }

    // The row's contact key: a number when the phone cell holds one, otherwise
    // an address. The phone cell is also checked for an address so a file we
    // exported (whose phone column carries the `email:` key of an email-keyed
    // contact) re-imports as the same contact rather than as an error row.
    const phoneCell = (row.phone ?? "").trim();
    const normalized = normalizeContactNumber(phoneCell);
    // The address to key by when the phone cell holds no number: the phone cell
    // itself (already an `email:` key from an export, or a bare address someone
    // typed into the wrong column), else the email column.
    const addressKey =
      emailContactKey(contactKeyEmail(phoneCell) ?? phoneCell) ?? emailContactKey(email);
    if (!normalized.ok && !addressKey) {
      summary.errors.push({
        row: fileRow,
        message: phoneCell
          ? `phone: ${normalized.reason}`
          : "phone: missing, and no email address to identify this contact by."
      });
      summary.skipped += 1;
      continue;
    }
    const phone = normalized.ok ? normalized.value : (addressKey as string);
    // An email-keyed row must carry its address in `email` too (the DB
    // constraint contacts_email_key_matches_email), whatever the file said.
    const keyEmail = contactKeyEmail(phone);
    const rowEmail = keyEmail ?? email;
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
      // Only write cells the file actually provided, blank means keep.
      const patch: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
        ...(name ? { display_name: name, name_source: "manual" } : {}),
        ...(rowEmail ? { email: rowEmail } : {}),
        ...(type ? { type: type as ContactType } : {}),
        ...(replyMode ? { sms_reply_mode: replyMode as SmsReplyMode } : {}),
        ...(pinned ? { pinned_md: pinned } : {})
      };
      // Alias-aware update-by-phone so a merged-away number updates the
      // surviving profile instead of recreating the one the owner just merged.
      const applyUpdate = async (): Promise<boolean> => {
        const lookup = db.from("contacts").select("id").eq("business_id", businessId);
        const aliasFilter = contactAliasOrFilter(phone);
        const { data: existing, error: selErr } = await (aliasFilter
          ? lookup.or(aliasFilter)
          : lookup.eq("customer_e164", phone)
        ).maybeSingle();
        if (selErr) throw new Error(selErr.message);
        if (!existing) return false;
        const { error: updErr } = await db.from("contacts").update(patch).eq("id", existing.id);
        if (updErr) throw new Error(updErr.message);
        return true;
      };

      const insertRow = async () =>
        db.from("contacts").insert({
          business_id: businessId,
          customer_e164: phone,
          display_name: name || null,
          ...(name ? { name_source: "manual" } : {}),
          email: rowEmail || null,
          ...(type ? { type: type as ContactType } : {}),
          ...(replyMode ? { sms_reply_mode: replyMode as SmsReplyMode } : {}),
          pinned_md: pinned || null
        });

      // Email cross-conflict (ported from BizBlasts' CustomerLinker): the
      // row's phone is unknown, but its email already identifies exactly one
      // existing CUSTOMER profile → same person, second number. Strict
      // guards: exactly one email match, both sides classified customer (a
      // row that re-types the contact is a signal they are NOT the same
      // person). Race-free by construction: the number is inserted as a
      // BARE row FIRST (the primary-key conflict arbitrates any concurrent
      // inbound auto-create, and a bare row means the merge can't
      // double-apply CSV content), then the CSV cells land on the SURVIVOR,
      // and only then the battle-tested merge_customer_memories RPC folds
      // the temp row in, locking both rows, recording the number in
      // alias_e164s, and deleting the temp row. Ordering matters: every
      // failure before the merge aborts cleanly (the bare temp row is a
      // harmless standalone contact a re-import updates), so there is no
      // half-merged state the summary can't describe.
      const tryEmailFold = async (): Promise<
        "no_match" | "raced" | "folded" | "created_unfolded"
      > => {
        if (!rowEmail) return "no_match";
        if (type && type !== "customer") return "no_match";
        const { data: matches, error: matchErr } = await db
          .from("contacts")
          .select("id, customer_e164, type")
          .eq("business_id", businessId)
          .ilike("email", escapeLikeLiteral(rowEmail))
          .limit(2);
        if (matchErr) throw new Error(matchErr.message);
        const rows = (matches ?? []) as Array<{
          id: string;
          customer_e164: string;
          type: string;
        }>;
        if (rows.length !== 1 || rows[0].type !== "customer") return "no_match";

        // An EMAIL-keyed row has no second number to fold in: the address IS
        // its identity, and the match already carries that address. So this is
        // not a merge, it is the same contact reached the same way. Patch them
        // and stop, rather than creating a second row for one person.
        // (applyUpdate ran first and missed, so the match is a different,
        // phone-keyed contact who gave us this address earlier.)
        if (isEmailContactKey(phone)) {
          const { error: patchOnlyErr } = await db
            .from("contacts")
            .update(patch)
            .eq("id", rows[0].id);
          if (patchOnlyErr) throw new Error(patchOnlyErr.message);
          return "folded";
        }

        const { error: insErr } = await db.from("contacts").insert({
          business_id: businessId,
          customer_e164: phone
        });
        if (insErr) {
          if (insErr.code !== PG_UNIQUE_VIOLATION) throw new Error(insErr.message);
          return "raced";
        }
        // CSV cells are deliberate owner edits, apply to the survivor
        // BEFORE the merge so a patch failure aborts the fold cleanly. On
        // that failure the bare temp row is removed again: leaving it would
        // make a RE-IMPORT of the row take the plain phone-update path
        // (the number now "exists") and silently skip the email fold forever.
        const { error: patchErr } = await db.from("contacts").update(patch).eq("id", rows[0].id);
        if (patchErr) {
          const { error: undoErr } = await db
            .from("contacts")
            .delete()
            .eq("business_id", businessId)
            .eq("customer_e164", phone);
          if (undoErr) {
            // Both the patch and the undo failed, surface both so the owner
            // knows the number now exists as a bare contact.
            throw new Error(`${patchErr.message} (temp row cleanup also failed: ${undoErr.message})`);
          }
          throw new Error(patchErr.message);
        }
        const { error: mergeErr } = await db.rpc("merge_customer_memories", {
          p_business_id: businessId,
          p_from_e164: phone,
          p_into_e164: rows[0].customer_e164
        });
        if (mergeErr) {
          // The fold target changed under us (deleted/merged mid-import),
          // promote the bare temp row to a full standalone contact instead.
          const { error: promoteErr } = await db
            .from("contacts")
            .update(patch)
            .eq("business_id", businessId)
            .eq("customer_e164", phone);
          if (promoteErr) throw new Error(promoteErr.message);
          return "created_unfolded";
        }
        return "folded";
      };

      const fireCreated = async () => {
        // contact_created triggers: an import-created contact may start
        // flows watching for new contacts (drip pacing spaces bulk
        // enrollments out). Best-effort inside fireContactEvent, a
        // trigger failure never fails the row. Timestamped like the
        // dashboard add: a re-imported number after a delete is a NEW
        // creation and must refire.
        await fireContactEvent(businessId, {
          kind: "contact_created",
          contact: {
            e164: phone,
            ...(name ? { name } : {}),
            ...(rowEmail ? { email: rowEmail } : {})
          },
          dedupeKey: `ce:created:${phone}:${Date.now()}`
        });
      };

      const retryAsUpdate = async () => {
        // Raced by a concurrent auto-create (inbound SMS/call) between the
        // lookup and the insert: the profile exists now, so apply the row's
        // fields as an update rather than dropping them.
        if (await applyUpdate()) {
          summary.updated += 1;
        } else {
          // The racing row vanished again (e.g. concurrent delete/merge),
          // report it instead of silently losing the row's data.
          throw new Error(
            `A concurrent change kept ${phone} from being saved; re-import this row.`
          );
        }
      };

      if (await applyUpdate()) {
        summary.updated += 1;
      } else {
        const fold = await tryEmailFold();
        if (fold === "folded") {
          summary.updated += 1;
        } else if (fold === "created_unfolded") {
          summary.created += 1;
          await fireCreated();
        } else if (fold === "raced") {
          await retryAsUpdate();
        } else {
          const { error: insErr } = await insertRow();
          if (insErr) {
            if (insErr.code !== PG_UNIQUE_VIOLATION) throw new Error(insErr.message);
            await retryAsUpdate();
          } else {
            summary.created += 1;
            await fireCreated();
          }
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
