/**
 * Contact records CSV import/export — the "book of business" loader.
 *
 * A row is a contact-linked record document (insurance policy, lease,
 * service contract, membership): title + the contact's phone number, plus
 * optional category, renewal/expiration dates, assigned employee, audience,
 * and free-text notes. Import creates records in the Documents library
 * linked to the contact (the daily sweep then reminds ahead of each
 * renewal date); export writes every linked record back out.
 *
 * Import semantics (row-by-row, never all-or-nothing):
 *   * `title` and `contact_phone` are required; the contact must already
 *     exist (primary number OR merged-away alias) — import contacts first.
 *   * An existing record with the SAME title on the SAME contact → update,
 *     but only with non-empty cells (blank = keep). Changing a date re-arms
 *     the sweep's reminder stamps. The stored original file is never
 *     rewritten — content_md is the canonical text, same as dashboard edits.
 *   * No match → create. The notes (or a rendered field summary) become the
 *     agent-facing content_md AND a small synthesized .md original in the
 *     business-docs bucket, so download/share behave like any other doc.
 *   * Records default to the 'staff' audience so an imported book of
 *     business can never leak to customer channels unless deliberately
 *     widened.
 *   * Bad rows are reported with their 1-based file row number and skipped;
 *     good rows still apply.
 *
 * Service-role only. Owner authorization is the API route's job
 * (requireBusinessRole before any call here) — same trust model as
 * csv/contacts.
 */

import { randomUUID } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import {
  BUSINESS_DOCS_BUCKET,
  CONTACT_DOCUMENT_RECORDS_LIMIT,
  DOCUMENT_CONTENT_MD_MAX_CHARS,
  DOCUMENT_SUMMARY_MAX_CHARS,
  parseExpirationInput
} from "@/lib/documents/core";
import type { BusinessDocumentRow } from "@/lib/documents/db";
import { parseCsv, serializeCsv } from "./csv";
import type { CsvImportSummary } from "./contacts";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Records import is heavier per row (storage write) than contacts. */
export const MAX_DOCUMENT_IMPORT_ROWS = 500;

export const DOCUMENTS_EXPORT_HEADERS = [
  "title",
  "contact_phone",
  "contact_name",
  "category",
  "renewal_date",
  "expires_at",
  "assigned_employee_phone",
  "audience",
  "notes",
  "status",
  "created_at"
] as const;

const AUDIENCES = ["clients", "staff", "both"] as const;

const EXPORT_PAGE_SIZE = 1000;

type ExportDocRow = Pick<
  BusinessDocumentRow,
  | "title"
  | "category"
  | "audience"
  | "content_md"
  | "status"
  | "contact_id"
  | "renewal_date"
  | "expires_at"
  | "assigned_employee_id"
  | "created_at"
>;

/** Every contact-linked record as CSV text (paginated read, no row cap). */
export async function exportDocumentsCsv(
  businessId: string,
  client?: SupabaseClient
): Promise<string> {
  const db = client ?? (await createSupabaseServiceClient());
  const rows: ExportDocRow[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await db
      .from("business_documents")
      .select(
        "title,category,audience,content_md,status,contact_id,renewal_date,expires_at,assigned_employee_id,created_at"
      )
      .eq("business_id", businessId)
      .not("contact_id", "is", null)
      .order("created_at", { ascending: true })
      .range(page * EXPORT_PAGE_SIZE, page * EXPORT_PAGE_SIZE + EXPORT_PAGE_SIZE - 1);
    if (error) throw new Error(`exportDocumentsCsv: ${error.message}`);
    const batch = (data ?? []) as unknown as ExportDocRow[];
    rows.push(...batch);
    if (batch.length < EXPORT_PAGE_SIZE) break;
  }

  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((id): id is string => !!id))];
  const employeeIds = [
    ...new Set(rows.map((r) => r.assigned_employee_id).filter((id): id is string => !!id))
  ];
  const contacts = new Map<string, { phone: string; name: string }>();
  if (contactIds.length > 0) {
    const { data, error } = await db
      .from("contacts")
      .select("id, customer_e164, display_name")
      .in("id", contactIds);
    if (error) throw new Error(`exportDocumentsCsv: ${error.message}`);
    for (const c of (data ?? []) as Array<{
      id: string;
      customer_e164: string;
      display_name: string | null;
    }>) {
      contacts.set(c.id, { phone: c.customer_e164, name: c.display_name?.trim() ?? "" });
    }
  }
  const employees = new Map<string, string>();
  if (employeeIds.length > 0) {
    const { data, error } = await db
      .from("ai_flow_team_members")
      .select("id, phone_e164")
      .in("id", employeeIds);
    if (error) throw new Error(`exportDocumentsCsv: ${error.message}`);
    for (const m of (data ?? []) as Array<{ id: string; phone_e164: string }>) {
      employees.set(m.id, m.phone_e164);
    }
  }

  return serializeCsv([
    [...DOCUMENTS_EXPORT_HEADERS],
    ...rows.map((r) => {
      const contact = r.contact_id ? contacts.get(r.contact_id) : undefined;
      return [
        r.title,
        contact?.phone ?? "",
        contact?.name ?? "",
        r.category,
        r.renewal_date ? r.renewal_date.slice(0, 10) : "",
        r.expires_at ? r.expires_at.slice(0, 10) : "",
        r.assigned_employee_id ? employees.get(r.assigned_employee_id) ?? "" : "",
        r.audience,
        r.content_md,
        r.status,
        r.created_at
      ];
    })
  ]);
}

/** Header + one example row showing the importable columns. */
export function documentsCsvTemplate(): string {
  return serializeCsv([
    [
      "title",
      "contact_phone",
      "category",
      "renewal_date",
      "expires_at",
      "assigned_employee_phone",
      "audience",
      "notes"
    ],
    [
      "Auto policy #A-1042",
      "+16025551234",
      "policy",
      "2027-03-01",
      "",
      "+16025559876",
      "staff",
      "Carrier: Acme Mutual. Premium $1,240/yr, $500 deductible."
    ]
  ]);
}

function renderRecordMd(fields: {
  title: string;
  category: string;
  contactLabel: string;
  renewalDate: string | null;
  expiresAt: string | null;
}): string {
  const lines = [`# ${fields.title}`, "", `- Category: ${fields.category}`, `- Contact: ${fields.contactLabel}`];
  if (fields.renewalDate) lines.push(`- Renewal date: ${fields.renewalDate.slice(0, 10)}`);
  if (fields.expiresAt) lines.push(`- Expires: ${fields.expiresAt.slice(0, 10)}`);
  return lines.join("\n");
}

/**
 * Import a contact-records CSV. Applies row-by-row (good rows land even when
 * others fail) and returns the per-row outcome summary.
 */
export async function importDocumentsCsv(
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
  for (const required of ["title", "contact_phone"]) {
    if (!parsed.headers.includes(required)) {
      summary.errors.push({ row: 1, message: `Missing required column: "${required}".` });
      return summary;
    }
  }
  if (parsed.rows.length > MAX_DOCUMENT_IMPORT_ROWS) {
    summary.errors.push({
      row: 0,
      message: `Too many rows (${parsed.rows.length}); the limit is ${MAX_DOCUMENT_IMPORT_ROWS} per file.`
    });
    return summary;
  }
  summary.totalRows = parsed.rows.length;
  const db = client ?? (await createSupabaseServiceClient());

  // One pre-count + a local increment keeps the flat records cap enforced
  // without a per-row count query. (Concurrent imports could overshoot by a
  // file's worth — acceptable for an abuse-safety cap.)
  const { count, error: countErr } = await db
    .from("business_documents")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .not("contact_id", "is", null);
  if (countErr) {
    summary.errors.push({ row: 0, message: `Count failed: ${countErr.message}` });
    return summary;
  }
  let linkedCount = count ?? 0;

  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    // 1-based file row: +1 for the header line, +1 for 0-index.
    const fileRow = i + 2;

    // Both headers are pre-validated above, so the cells always exist
    // (parseCsv pads short rows with "").
    const title = row.title.trim().slice(0, 200);
    if (!title) {
      summary.errors.push({ row: fileRow, message: "title is required." });
      summary.skipped += 1;
      continue;
    }
    const normalized = normalizeContactNumber(row.contact_phone);
    if (!normalized.ok) {
      summary.errors.push({ row: fileRow, message: `contact_phone: ${normalized.reason}` });
      summary.skipped += 1;
      continue;
    }
    const phone = normalized.value;

    const category = (row.category ?? "").trim().slice(0, 100);
    const audienceRaw = (row.audience ?? "").trim().toLowerCase();
    if (audienceRaw && !(AUDIENCES as readonly string[]).includes(audienceRaw)) {
      summary.errors.push({
        row: fileRow,
        message: `audience: "${audienceRaw}" is not one of ${AUDIENCES.join(", ")}.`
      });
      summary.skipped += 1;
      continue;
    }
    const renewalRaw = (row.renewal_date ?? "").trim();
    const renewalDate = renewalRaw ? parseExpirationInput(renewalRaw) : null;
    if (renewalRaw && !renewalDate) {
      summary.errors.push({ row: fileRow, message: `renewal_date: "${renewalRaw}" is not a date.` });
      summary.skipped += 1;
      continue;
    }
    const expiresRaw = (row.expires_at ?? "").trim();
    const expiresAt = expiresRaw ? parseExpirationInput(expiresRaw) : null;
    if (expiresRaw && !expiresAt) {
      summary.errors.push({ row: fileRow, message: `expires_at: "${expiresRaw}" is not a date.` });
      summary.skipped += 1;
      continue;
    }
    const notes = (row.notes ?? "").trim();

    try {
      // The contact must already exist — a record without its person is
      // meaningless, and silently creating bare contacts here would bypass
      // the contacts importer's dedupe/merge logic.
      const { data: contact, error: contactErr } = await db
        .from("contacts")
        .select("id, display_name, customer_e164")
        .eq("business_id", businessId)
        .or(`customer_e164.eq.${phone},alias_e164s.cs.{${phone}}`)
        .maybeSingle();
      if (contactErr) throw new Error(contactErr.message);
      if (!contact) {
        throw new Error(`No contact with number ${phone} — import your contacts first.`);
      }
      const contactRow = contact as { id: string; display_name: string | null; customer_e164: string };
      const contactLabel = contactRow.display_name?.trim() || contactRow.customer_e164;

      let assignedEmployeeId: string | null = null;
      const employeeRaw = (row.assigned_employee_phone ?? "").trim();
      if (employeeRaw) {
        const employeeNorm = normalizeContactNumber(employeeRaw);
        if (!employeeNorm.ok) {
          throw new Error(`assigned_employee_phone: ${employeeNorm.reason}`);
        }
        const { data: member, error: memberErr } = await db
          .from("ai_flow_team_members")
          .select("id")
          .eq("business_id", businessId)
          .eq("phone_e164", employeeNorm.value)
          .maybeSingle();
        if (memberErr) throw new Error(memberErr.message);
        if (!member) {
          throw new Error(
            `assigned_employee_phone: no employee with number ${employeeNorm.value}.`
          );
        }
        assignedEmployeeId = (member as { id: string }).id;
      }

      // Same title on the same contact = the same record → update in place.
      const { data: existingDocs, error: existingErr } = await db
        .from("business_documents")
        .select("id, renewal_date, expires_at")
        .eq("business_id", businessId)
        .eq("contact_id", contactRow.id)
        .eq("title", title)
        .limit(2);
      if (existingErr) throw new Error(existingErr.message);
      const matches = (existingDocs ?? []) as Array<{
        id: string;
        renewal_date: string | null;
        expires_at: string | null;
      }>;
      if (matches.length > 1) {
        throw new Error(
          `Multiple documents titled "${title}" exist for this contact; rename one first.`
        );
      }

      if (matches.length === 1) {
        const existing = matches[0];
        // Only write cells the file actually provided — blank means keep.
        // A changed date re-arms the sweep's one-reminder-per-state stamps.
        const patch: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
          ...(category ? { category } : {}),
          ...(audienceRaw ? { audience: audienceRaw } : {}),
          ...(assignedEmployeeId ? { assigned_employee_id: assignedEmployeeId } : {}),
          ...(notes ? { content_md: notes.slice(0, DOCUMENT_CONTENT_MD_MAX_CHARS) } : {}),
          ...(renewalDate && renewalDate !== existing.renewal_date
            ? {
                renewal_date: renewalDate,
                renewal_due_notified_at: null,
                renewal_final_notified_at: null,
                renewal_overdue_notified_at: null,
                renewal_outreach_enqueued_at: null
              }
            : {}),
          ...(expiresAt && expiresAt !== existing.expires_at
            ? {
                expires_at: expiresAt,
                expiring_soon_notified_at: null,
                expired_notified_at: null
              }
            : {})
        };
        const { error: updErr } = await db
          .from("business_documents")
          .update(patch)
          .eq("business_id", businessId)
          .eq("id", existing.id);
        if (updErr) throw new Error(updErr.message);
        summary.updated += 1;
        continue;
      }

      if (linkedCount >= CONTACT_DOCUMENT_RECORDS_LIMIT) {
        throw new Error(
          `Contact document limit reached (${CONTACT_DOCUMENT_RECORDS_LIMIT}); remaining rows were skipped.`
        );
      }

      const contentMd = (
        notes ||
        renderRecordMd({ title, category: category || "record", contactLabel, renewalDate, expiresAt })
      ).slice(0, DOCUMENT_CONTENT_MD_MAX_CHARS);
      const summaryText = `${category || "Record"} for ${contactLabel}.`.slice(
        0,
        DOCUMENT_SUMMARY_MAX_CHARS
      );

      // Synthesize the "original file" so download/share behave like any
      // other document (same approach as saving an Agent artifact).
      const documentId = randomUUID();
      const storagePath = `${businessId}/${documentId}/record.md`;
      const bytes = Buffer.from(contentMd, "utf8");
      const { error: uploadErr } = await db.storage
        .from(BUSINESS_DOCS_BUCKET)
        .upload(storagePath, bytes, { contentType: "text/markdown" });
      if (uploadErr) throw new Error(`Storing the record failed: ${uploadErr.message}`);

      const { error: insErr } = await db.from("business_documents").insert({
        id: documentId,
        business_id: businessId,
        title,
        category: category || "record",
        // Records default to internal-only: a book of business must never
        // leak to customer channels unless the owner deliberately widens it.
        audience: audienceRaw || "staff",
        storage_path: storagePath,
        mime_type: "text/markdown",
        byte_size: bytes.byteLength,
        content_md: contentMd,
        summary: summaryText,
        status: "ready",
        expires_at: expiresAt,
        contact_id: contactRow.id,
        renewal_date: renewalDate,
        assigned_employee_id: assignedEmployeeId
      });
      if (insErr) {
        // Compensate the uploaded object so an insert failure leaves no orphan.
        const { error: removeErr } = await db.storage
          .from(BUSINESS_DOCS_BUCKET)
          .remove([storagePath]);
        if (removeErr) {
          throw new Error(`${insErr.message} (orphan cleanup also failed: ${removeErr.message})`);
        }
        throw new Error(insErr.message);
      }
      linkedCount += 1;
      summary.created += 1;
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
