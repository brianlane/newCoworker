/**
 * Follow Up Boss import: job rows, the CSV preview, and the real import.
 *
 * The import is a two-step surface on /dashboard/import-export:
 *
 *   1. PREVIEW: parse the export, show which of its columns mapped onto
 *      which of our fields, which columns nothing claimed, how many rows
 *      carry a usable identity, and the first few that do not. Nothing is
 *      written and nothing is stored: the file stays on the owner's machine.
 *   2. IMPORT: the same file is sent again with dryRun false and applied row
 *      by row through the shared contact identity core (the CSV importer's
 *      exact resolution: alias-aware update, email fold, create).
 *
 * Sending the file twice is deliberate. The alternative is parking a copy of
 * a customer's whole contact list on the job row between the two steps, and
 * there is no reason to hold their data to show them a number.
 *
 * WHY A CSV AND NOT THEIR API: the Follow Up Boss API Terms of Use require
 * registering a system, forbid using the API or its data to offer a product
 * that competes with them, and forbid retaining their data beyond what an
 * integration needs. A one-way migration off their platform is none of those
 * things. Their own help center tells customers to export their contacts
 * from People with "Export All Columns" in order to move to another system,
 * so that export, handed over by the person who owns it, is the path we take.
 * Notes and deals are NOT in that export and therefore do not come across.
 *
 * Contact events fire the way the CSV importer's do: contact_created for new
 * contacts, tag_changed (added) when an import adds tags to an existing
 * contact, so tag automations run. Dedupe keys are job-scoped, so a retry
 * inside one job cannot double-fire a flow while a later re-import still can
 * (matching the CSV importer's delete-then-reimport behavior).
 */

import type { createSupabaseServiceClient } from "@/lib/supabase/server";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";
import { normalizeContactTags } from "@/lib/customer-memory/types";
import { upsertContactIdentity } from "@/lib/contacts/identity";
import { parseCsv } from "@/lib/csv/csv";
import { MAX_IMPORT_ROWS } from "@/lib/csv/contacts";
import {
  hasIdentityColumn,
  mapFubCsvRow,
  matchFubHeaders,
  type FubHeaderMap,
  type MappedFubContact
} from "./map";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const FUB_IMPORT_STATUSES = [
  "pending",
  "dry_run_done",
  "running",
  "done",
  "failed"
] as const;
export type FubImportStatus = (typeof FUB_IMPORT_STATUSES)[number];

export type FubImportJobRow = {
  id: string;
  business_id: string;
  status: FubImportStatus;
  dry_run: boolean;
  counts: Record<string, unknown>;
  error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

const JOB_COLUMNS =
  "id, business_id, status, dry_run, counts, error, created_by, created_at, updated_at";

/** Row failures kept on the job row; enough to diagnose, not a second copy. */
const MAX_RECORDED_FAILURES = 10;

// ---------------------------------------------------------------------------
// Job rows
// ---------------------------------------------------------------------------

/** Insert a job for one preview or one import. */
export async function createFubImportJob(
  db: SupabaseClient,
  businessId: string,
  createdBy: string | null,
  dryRun: boolean
): Promise<FubImportJobRow> {
  const { data, error } = await db
    .from("fub_import_jobs")
    .insert({ business_id: businessId, created_by: createdBy, dry_run: dryRun })
    .select(JOB_COLUMNS)
    .single();
  if (error || !data) {
    throw new Error(`createFubImportJob: ${error?.message ?? "insert returned no row"}`);
  }
  return data as FubImportJobRow;
}

/** The business's newest job (the status card's read), or null. */
export async function latestFubImportJob(
  db: SupabaseClient,
  businessId: string
): Promise<FubImportJobRow | null> {
  const { data, error } = await db
    .from("fub_import_jobs")
    .select(JOB_COLUMNS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`latestFubImportJob: ${error.message}`);
  return (data as FubImportJobRow | null) ?? null;
}

/**
 * Patch a job row. PostgREST reports no error on a zero-row match, so the
 * matched count is checked: losing the job mid-run must surface, not
 * silently drop progress.
 */
export async function updateFubImportJob(
  db: SupabaseClient,
  businessId: string,
  jobId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { data, error } = await db
    .from("fub_import_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", jobId)
    .select("id");
  if (error) throw new Error(`updateFubImportJob: ${error.message}`);
  if ((data ?? []).length === 0) {
    throw new Error(`updateFubImportJob: job ${jobId} not found`);
  }
}

/** What the dashboard sees. */
export type PublicFubImportJob = {
  id: string;
  status: FubImportStatus;
  dryRun: boolean;
  counts: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toPublicFubImportJob(row: FubImportJobRow): PublicFubImportJob {
  return {
    id: row.id,
    status: row.status,
    dryRun: row.dry_run,
    counts: row.counts,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ---------------------------------------------------------------------------
// Preview (pure)
// ---------------------------------------------------------------------------

export type FubCsvPreview = {
  totalRows: number;
  /** Rows carrying a usable phone or email, so a real run would apply them. */
  importable: number;
  /** Rows with no identity we could key on. */
  unusable: number;
  /** Which file column feeds each of our fields, for the owner to check. */
  mapping: Record<string, string[]>;
  /** Columns nothing claimed. Named so a dropped column is never a surprise. */
  ignoredColumns: string[];
  /** The first few unusable rows, with why. */
  problems: string[];
};

export type FubCsvParse =
  | { ok: true; preview: FubCsvPreview; map: FubHeaderMap; rows: Record<string, string>[] }
  | { ok: false; error: string };

/**
 * Parse and map an export without touching the database. Shared by the
 * preview step and the real import, so what the owner confirms is exactly
 * what runs.
 */
export function previewFubCsv(csvText: string): FubCsvParse {
  const parsed = parseCsv(csvText);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { map, unmatched } = matchFubHeaders(parsed.headers);
  if (!hasIdentityColumn(map)) {
    return {
      ok: false,
      error:
        "No phone or email column found. Re-export from Follow Up Boss with " +
        '"Export All Columns" checked so the contact details come with it.'
    };
  }
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    return {
      ok: false,
      error: `Too many rows (${parsed.rows.length}); the limit is ${MAX_IMPORT_ROWS} per file. Filter the Smart List and export again in batches.`
    };
  }
  const problems: string[] = [];
  let importable = 0;
  for (let i = 0; i < parsed.rows.length; i++) {
    // 1-based file row: +1 for the header line, +1 for the 0-index.
    const mapped = mapFubCsvRow(parsed.rows[i], map, i + 2);
    if (mapped.ok) importable += 1;
    else if (problems.length < MAX_RECORDED_FAILURES) problems.push(mapped.reason);
  }
  const mapping: Record<string, string[]> = {};
  for (const [field, headers] of Object.entries(map)) {
    if (headers.length > 0) mapping[field] = headers;
  }
  return {
    ok: true,
    map,
    rows: parsed.rows,
    preview: {
      totalRows: parsed.rows.length,
      importable,
      unusable: parsed.rows.length - importable,
      mapping,
      ignoredColumns: unmatched,
      problems
    }
  };
}

// ---------------------------------------------------------------------------
// Real import
// ---------------------------------------------------------------------------

export type FubImportSummary = {
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  failures: string[];
};

/**
 * One person through the shared identity core, then the import-only
 * follow-ups the core's callers own: merging tags (never removing any),
 * filling lead_source only where it is empty (the column's fill-only
 * contract), and firing the contact events that make automations run.
 */
async function importOnePerson(
  db: SupabaseClient,
  businessId: string,
  jobId: string,
  mapped: MappedFubContact
): Promise<"created" | "updated"> {
  const { key, email, name, leadSource, tags } = mapped;
  const nowIso = new Date().toISOString();
  const result = await upsertContactIdentity(db, businessId, {
    key,
    email,
    patch: {
      updated_at: nowIso,
      ...(name ? { display_name: name, name_source: "manual" } : {}),
      ...(email ? { email } : {})
    },
    insert: {
      display_name: name || null,
      ...(name ? { name_source: "manual" } : {}),
      email: email || null,
      ...(leadSource ? { lead_source: leadSource } : {}),
      ...(tags.length > 0 ? { tags } : {})
    },
    readColumns: ["tags", "lead_source"]
  });

  if (result.kind === "created" && result.via === "insert") {
    // The insert payload already carried tags + lead_source.
    await fireContactEvent(businessId, {
      kind: "contact_created",
      contact: {
        e164: key,
        ...(name ? { name } : {}),
        ...(email ? { email } : {}),
        ...(tags.length > 0 ? { tags } : {})
      },
      dedupeKey: `ce:created:${key}:fub:${jobId}`
    });
    return "created";
  }

  // Updated (or promoted from a failed fold, where `before` is null and the
  // promote patch carried no tags): merge tags additively and fill
  // lead_source only when the contact has none.
  const beforeTags = Array.isArray(result.before?.tags) ? (result.before.tags as string[]) : [];
  const merged = normalizeContactTags([...beforeTags, ...tags]);
  const beforeLower = new Set(normalizeContactTags(beforeTags).map((t) => t.toLowerCase()));
  const addedTags = merged.filter((t) => !beforeLower.has(t.toLowerCase()));
  const beforeLeadSource = (result.before?.lead_source as string | null | undefined) ?? null;
  const fillLeadSource = leadSource !== null && beforeLeadSource === null;
  if (result.contactId && (addedTags.length > 0 || fillLeadSource)) {
    const { error } = await db
      .from("contacts")
      .update({
        ...(addedTags.length > 0 ? { tags: merged } : {}),
        ...(fillLeadSource ? { lead_source: leadSource } : {}),
        updated_at: nowIso
      })
      .eq("id", result.contactId);
    if (error) throw new Error(`tag/source update: ${error.message}`);
  }

  if (result.kind === "created") {
    await fireContactEvent(businessId, {
      kind: "contact_created",
      contact: {
        e164: key,
        ...(name ? { name } : {}),
        ...(email ? { email } : {}),
        ...(merged.length > 0 ? { tags: merged } : {})
      },
      dedupeKey: `ce:created:${key}:fub:${jobId}`
    });
    return "created";
  }
  // tag_changed per newly added tag, the dashboard tag-edit convention, so
  // "when this tag is added" automations run for imported stage tags too.
  for (const tag of addedTags) {
    await fireContactEvent(businessId, {
      kind: "tag_changed",
      contact: { e164: key, tags: merged },
      tag,
      change: "added",
      dedupeKey: `ce:tag:${key}:${tag.toLowerCase()}:added:fub:${jobId}`
    });
  }
  return "updated";
}

/**
 * Apply an already-parsed export, row by row. A row that throws is recorded
 * and skipped; the rows around it still land, the same never-all-or-nothing
 * contract the contacts CSV importer has.
 */
export async function importFubCsv(
  db: SupabaseClient,
  businessId: string,
  jobId: string,
  parse: Extract<FubCsvParse, { ok: true }>
): Promise<FubImportSummary> {
  const summary: FubImportSummary = {
    totalRows: parse.rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    failures: []
  };
  const record = (reason: string) => {
    summary.skipped += 1;
    if (summary.failures.length < MAX_RECORDED_FAILURES) summary.failures.push(reason);
  };
  for (let i = 0; i < parse.rows.length; i++) {
    const mapped = mapFubCsvRow(parse.rows[i], parse.map, i + 2);
    if (!mapped.ok) {
      record(mapped.reason);
      continue;
    }
    try {
      const outcome = await importOnePerson(db, businessId, jobId, mapped.value);
      if (outcome === "created") summary.created += 1;
      else summary.updated += 1;
    } catch (e) {
      record(`row ${i + 2}: ${e instanceof Error ? e.message : "unexpected error"}`);
    }
  }
  return summary;
}
