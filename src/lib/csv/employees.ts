/**
 * Employees (ai_flow_team_members) CSV import/export.
 *
 * Same contract as contacts.ts: export includes read-only columns, import
 * recognizes only the editable subset so an exported file re-imports as a
 * no-op-ish update. Schedules travel in the same compact text form the
 * Employees page uses ("mon-fri 09:00-17:00") and are parsed strictly — a
 * typo'd schedule errors the row instead of silently sidelining the member.
 *
 * Upsert key: (business_id, phone) — the roster's DB uniqueness. `phone` is
 * normalized like the contacts import but must resolve to full E.164 (the
 * roster check constraint rejects short codes).
 *
 * Service-role only; the API route owns requireOwner.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import type { TeamMemberRow } from "@/lib/db/employees";
import { formatScheduleText, parseScheduleText } from "@/lib/employees/schedule-text";
import { parseCsv, serializeCsv } from "./csv";
import { MAX_IMPORT_ROWS, type CsvImportSummary } from "./contacts";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const EMPLOYEES_EXPORT_HEADERS = [
  "name",
  "phone",
  "email",
  "active",
  "weekly_schedule",
  "preferred_times",
  "last_offered_at",
  "created_at"
] as const;

const MEMBER_COLUMNS =
  "id,name,phone_e164,email,active,weekly_schedule,preferred_windows,last_offered_at,created_at";

const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Full roster as CSV text. */
export async function exportEmployeesCsv(
  businessId: string,
  client?: SupabaseClient
): Promise<string> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("ai_flow_team_members")
    .select(MEMBER_COLUMNS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`exportEmployeesCsv: ${error.message}`);
  const rows = (data ?? []) as unknown as TeamMemberRow[];
  return serializeCsv([
    [...EMPLOYEES_EXPORT_HEADERS],
    ...rows.map((r) => [
      r.name,
      r.phone_e164,
      r.email ?? "",
      r.active ? "true" : "false",
      formatScheduleText(r.weekly_schedule),
      formatScheduleText(r.preferred_windows),
      r.last_offered_at ?? "",
      r.created_at
    ])
  ]);
}

/** Header + one example row showing the importable columns. */
export function employeesCsvTemplate(): string {
  return serializeCsv([
    ["name", "phone", "email", "active", "weekly_schedule", "preferred_times"],
    ["Alex Rivera", "+16025551234", "alex@example.com", "true", "mon-fri 09:00-17:00", "mon-fri 09:00-12:00"]
  ]);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseBooleanCell(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (["true", "yes", "y", "1", "t"].includes(v)) return true;
  if (["false", "no", "n", "0", "f"].includes(v)) return false;
  return null;
}

/**
 * Import an employees CSV. Row-by-row like the contacts import; returns the
 * same summary shape.
 */
export async function importEmployeesCsv(
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
  for (const required of ["name", "phone"]) {
    if (!parsed.headers.includes(required)) {
      summary.errors.push({ row: 1, message: `Missing required column: "${required}".` });
      return summary;
    }
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
    const fileRow = i + 2;

    // `name`/`phone` are required headers, so parseCsv guarantees the keys.
    const name = row.name.trim();
    if (!name) {
      summary.errors.push({ row: fileRow, message: "name: required." });
      summary.skipped += 1;
      continue;
    }
    const normalized = normalizeContactNumber(row.phone);
    // Roster numbers must be dialable E.164 — short codes normalize fine for
    // contacts but can't receive route_to_team offers.
    if (!normalized.ok || !E164_RE.test(normalized.value)) {
      summary.errors.push({
        row: fileRow,
        message: `phone: "${row.phone.trim()}" is not a valid phone number (e.g. +16025551234).`
      });
      summary.skipped += 1;
      continue;
    }
    const phone = normalized.value;

    const email = (row.email ?? "").trim();
    if (email && !EMAIL_RE.test(email)) {
      summary.errors.push({ row: fileRow, message: `email: "${email}" is not a valid address.` });
      summary.skipped += 1;
      continue;
    }

    const activeRaw = (row.active ?? "").trim();
    const active = activeRaw ? parseBooleanCell(activeRaw) : null;
    if (activeRaw && active === null) {
      summary.errors.push({
        row: fileRow,
        message: `active: "${activeRaw}" is not true/false.`
      });
      summary.skipped += 1;
      continue;
    }

    const scheduleText = (row.weekly_schedule ?? "").trim();
    const preferredText = (row.preferred_times ?? "").trim();
    const schedule = parseScheduleText(scheduleText);
    if (!schedule.ok) {
      summary.errors.push({ row: fileRow, message: `weekly_schedule: ${schedule.error}` });
      summary.skipped += 1;
      continue;
    }
    const preferred = parseScheduleText(preferredText);
    if (!preferred.ok) {
      summary.errors.push({ row: fileRow, message: `preferred_times: ${preferred.error}` });
      summary.skipped += 1;
      continue;
    }

    try {
      const { data: existing, error: selErr } = await db
        .from("ai_flow_team_members")
        .select("id")
        .eq("business_id", businessId)
        .eq("phone_e164", phone)
        .maybeSingle();
      if (selErr) throw new Error(selErr.message);

      if (existing) {
        // Blank cells mean "keep" — only provided values are written.
        const patch: Record<string, unknown> = {
          name,
          ...(email ? { email } : {}),
          ...(active !== null ? { active } : {}),
          ...(scheduleText ? { weekly_schedule: schedule.value } : {}),
          ...(preferredText ? { preferred_windows: preferred.value } : {})
        };
        const { error: updErr } = await db
          .from("ai_flow_team_members")
          .update(patch)
          .eq("id", existing.id);
        if (updErr) throw new Error(updErr.message);
        summary.updated += 1;
      } else {
        const { error: insErr } = await db.from("ai_flow_team_members").insert({
          business_id: businessId,
          name,
          phone_e164: phone,
          email: email || null,
          ...(active !== null ? { active } : {}),
          weekly_schedule: schedule.value,
          preferred_windows: preferred.value
        });
        if (insErr) throw new Error(insErr.message);
        summary.created += 1;
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
