/**
 * Follow Up Boss import: job rows, the dry-run inventory, and the chunked
 * resumable real run.
 *
 * The import is a two-step surface on /dashboard/import-export:
 *
 *   1. DRY RUN (creating a job): count people/notes/deals via `_metadata.total`,
 *      list the stages with their people counts, and inventory the smart
 *      lists and action plans (names only: they are imported as a REPORT,
 *      not as segments/flows). Nothing is written to contacts.
 *   2. REAL RUN: people in pages, then notes, then deals. People go through
 *      the shared contact identity core (the CSV importer's exact
 *      resolution: alias-aware update, email fold, create), notes and deals
 *      land idempotently through their (business_id, external_source,
 *      external_id) upsert keys, and the cursor jsonb advances after every
 *      page so a timed-out or re-issued run RESUMES instead of restarting.
 *
 * Contact events fire the way the CSV importer's do: contact_created for
 * new contacts, tag_changed (added) when an import adds tags to an existing
 * contact, so tag automations run. Dedupe keys are job-scoped (stable per
 * job), so re-processing a page after a mid-page crash cannot double-fire a
 * flow, while a later re-import job still can (a re-imported contact is a
 * fresh event, matching the CSV importer's delete-then-reimport behavior).
 *
 * PostgREST caps un-limited selects at 1000 rows and FUB caps pages at 100,
 * so everything here is paginated on both sides.
 */

import type { createSupabaseServiceClient } from "@/lib/supabase/server";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";
import { normalizeContactTags } from "@/lib/customer-memory/types";
import { upsertContactIdentity } from "@/lib/contacts/identity";
import { contactAliasOrFilter } from "../../../supabase/functions/_shared/contact_key";
import { FUB_PAGE_LIMIT, type FubClient, type FubPage } from "./client";
import { mapFubDeal, mapFubNote, mapFubPerson, type MappedFubContact } from "./map";

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
  api_key_encrypted: string | null;
  counts: Record<string, unknown>;
  cursor: Record<string, unknown>;
  error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

const JOB_COLUMNS =
  "id, business_id, status, dry_run, api_key_encrypted, counts, cursor, error, created_by, created_at, updated_at";

/** Person fields the import needs (FUB `fields` param trims the payload). */
const PEOPLE_FIELDS = "id,name,firstName,lastName,stage,source,tags,emails,phones";
/** Person fields when only resolving note/deal linkage. */
const RESOLVE_FIELDS = "id,emails,phones";

/** Inventory listing caps: pages of 100, plenty for names-only reports. */
const INVENTORY_MAX_PAGES = 5;

/** How many failure REASONS the counts report keeps (the count keeps going). */
const MAX_RECORDED_FAILURES = 10;

// ---------------------------------------------------------------------------
// Job rows
// ---------------------------------------------------------------------------

/**
 * Insert a new job and wipe the saved key off every OLDER job for the
 * business: one live key per tenant, so "delete saved key" has one target.
 */
export async function createFubImportJob(
  db: SupabaseClient,
  businessId: string,
  apiKeyEncrypted: string,
  createdBy: string | null
): Promise<FubImportJobRow> {
  const { data, error } = await db
    .from("fub_import_jobs")
    .insert({
      business_id: businessId,
      api_key_encrypted: apiKeyEncrypted,
      created_by: createdBy
    })
    .select(JOB_COLUMNS)
    .single();
  if (error || !data) {
    throw new Error(`createFubImportJob: ${error?.message ?? "insert returned no row"}`);
  }
  const row = data as FubImportJobRow;
  const { error: wipeErr } = await db
    .from("fub_import_jobs")
    .update({ api_key_encrypted: null, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .neq("id", row.id)
    .not("api_key_encrypted", "is", null);
  if (wipeErr) throw new Error(`createFubImportJob: wipe older keys: ${wipeErr.message}`);
  return row;
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

/** One job by id, scoped to its business. */
export async function getFubImportJob(
  db: SupabaseClient,
  businessId: string,
  jobId: string
): Promise<FubImportJobRow | null> {
  const { data, error } = await db
    .from("fub_import_jobs")
    .select(JOB_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(`getFubImportJob: ${error.message}`);
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

/**
 * Null out the saved key ("delete saved key"). Returns how many rows
 * matched (0 = job unknown; the route turns that into a 404).
 */
export async function wipeFubImportJobKey(
  db: SupabaseClient,
  businessId: string,
  jobId: string
): Promise<number> {
  const { data, error } = await db
    .from("fub_import_jobs")
    .update({ api_key_encrypted: null, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", jobId)
    .select("id");
  if (error) throw new Error(`wipeFubImportJobKey: ${error.message}`);
  return (data ?? []).length;
}

/**
 * The pasted key must never surface in an error, a log line, or the job
 * row's error column. Belt and braces for messages that might embed a
 * request echo some day.
 */
export function sanitizeFubError(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}

/** What the dashboard sees. The ciphertext NEVER leaves the server. */
export type PublicFubImportJob = {
  id: string;
  status: FubImportStatus;
  dryRun: boolean;
  hasApiKey: boolean;
  counts: Record<string, unknown>;
  progress: { phase: string; offset: number };
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toPublicFubImportJob(row: FubImportJobRow): PublicFubImportJob {
  const cursor = normalizeFubCursor(row.cursor);
  return {
    id: row.id,
    status: row.status,
    dryRun: row.dry_run,
    hasApiKey: row.api_key_encrypted !== null && row.api_key_encrypted !== "",
    counts: row.counts,
    progress: { phase: cursor.phase, offset: cursor.offset },
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

export type FubDryRunCounts = {
  people: number | null;
  notes: number | null;
  deals: number | null;
  stages: Array<{ name: string; peopleCount: number | null }>;
  /** Names only: smart lists are imported as a report, not as segments. */
  smartLists: string[];
  /** Names + FUB status: imported as a report, not as AiFlows. */
  actionPlans: Array<{ name: string; status: string | null }>;
  /**
   * Distinct person.source labels on the newest page of people. FUB has no
   * sources endpoint (docs.followupboss.com/llms.txt, checked 2026-08-20):
   * source is a free-text label on each person, so this is a sample, not a
   * complete list.
   */
  sourcesSample: string[];
};

async function listAllPages<T>(
  fetchPage: (params: { limit: number; offset: number; next?: string }) => Promise<FubPage<T>>,
  maxPages: number
): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined;
  let offset = 0;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage({ limit: FUB_PAGE_LIMIT, offset, next });
    out.push(...page.items);
    if (!page.next || page.items.length === 0) break;
    next = page.next;
    offset += page.items.length;
  }
  return out;
}

/** Count everything and inventory the account. Read-only on both sides. */
export async function dryRunFubImport(client: FubClient): Promise<FubDryRunCounts> {
  const peopleProbe = await client.getPeople({ limit: 1, fields: "id" });
  const notesProbe = await client.getNotes({ limit: 1 });
  const dealsProbe = await client.getDeals({ limit: 1 });
  const stages = await listAllPages((p) => client.getStages(p), INVENTORY_MAX_PAGES);
  const smartLists = await listAllPages((p) => client.getSmartLists(p), INVENTORY_MAX_PAGES);
  const actionPlans = await listAllPages((p) => client.getActionPlans(p), INVENTORY_MAX_PAGES);
  const sourcesPage = await client.getPeople({ limit: FUB_PAGE_LIMIT, fields: "id,source" });
  const sources = new Set<string>();
  for (const person of sourcesPage.items) {
    const label = (person.source ?? "").trim();
    if (label) sources.add(label);
  }
  return {
    people: peopleProbe.total,
    notes: notesProbe.total,
    deals: dealsProbe.total,
    stages: stages.map((s) => ({
      name: (s.name ?? "").trim() || `stage ${s.id}`,
      peopleCount: typeof s.peopleCount === "number" ? s.peopleCount : null
    })),
    smartLists: smartLists
      .map((l) => (l.name ?? "").trim())
      .filter((name) => name.length > 0),
    actionPlans: actionPlans
      .map((p) => ({ name: (p.name ?? "").trim(), status: (p.status ?? "").trim() || null }))
      .filter((p) => p.name.length > 0),
    sourcesSample: [...sources].sort()
  };
}

// ---------------------------------------------------------------------------
// Real run
// ---------------------------------------------------------------------------

export type FubImportPhase = "people" | "notes" | "deals" | "done";

export type FubImportCursor = {
  phase: FubImportPhase;
  /** FUB keyset token for the current phase's next page. */
  next: string | null;
  /** Items already imported in the current phase (offset fallback + UI). */
  offset: number;
  /** stageId -> stage name, cached when the deals phase starts. */
  dealStages?: Record<string, string>;
};

export type FubRunCounts = {
  contactsCreated: number;
  contactsUpdated: number;
  contactsSkipped: number;
  notesImported: number;
  notesSkipped: number;
  dealsImported: number;
  dealsSkipped: number;
  failureCount: number;
  failures: Array<{ scope: "person" | "note" | "deal"; reason: string }>;
};

const PHASES: FubImportPhase[] = ["people", "notes", "deals", "done"];

/** Cursor jsonb -> typed cursor, tolerating an empty {} from a fresh job. */
export function normalizeFubCursor(raw: Record<string, unknown>): FubImportCursor {
  const phase = PHASES.includes(raw.phase as FubImportPhase)
    ? (raw.phase as FubImportPhase)
    : "people";
  return {
    phase,
    next: typeof raw.next === "string" && raw.next.length > 0 ? raw.next : null,
    offset: typeof raw.offset === "number" && raw.offset >= 0 ? raw.offset : 0,
    ...(typeof raw.dealStages === "object" && raw.dealStages !== null
      ? { dealStages: raw.dealStages as Record<string, string> }
      : {})
  };
}

/** counts.run jsonb -> typed tallies, zeroed on a fresh job. */
export function normalizeFubRunCounts(raw: unknown): FubRunCounts {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<FubRunCounts>;
  const num = (v: unknown) => (typeof v === "number" && v >= 0 ? v : 0);
  return {
    contactsCreated: num(source.contactsCreated),
    contactsUpdated: num(source.contactsUpdated),
    contactsSkipped: num(source.contactsSkipped),
    notesImported: num(source.notesImported),
    notesSkipped: num(source.notesSkipped),
    dealsImported: num(source.dealsImported),
    dealsSkipped: num(source.dealsSkipped),
    failureCount: num(source.failureCount),
    failures: Array.isArray(source.failures)
      ? (source.failures as FubRunCounts["failures"]).slice(0, MAX_RECORDED_FAILURES)
      : []
  };
}

function recordFailure(counts: FubRunCounts, scope: "person" | "note" | "deal", reason: string) {
  counts.failureCount += 1;
  if (counts.failures.length < MAX_RECORDED_FAILURES) {
    counts.failures.push({ scope, reason });
  }
}

/** Advance within the phase (more pages) or into the next phase. */
function advanceCursor(cursor: FubImportCursor, page: FubPage<unknown>, nextPhase: FubImportPhase) {
  if (page.next && page.items.length > 0) {
    cursor.next = page.next;
    cursor.offset += page.items.length;
  } else {
    cursor.phase = nextPhase;
    cursor.next = null;
    cursor.offset = 0;
  }
}

/** Alias-aware contact lookup by key (same filter the identity core uses). */
async function findContactIdByKey(
  db: SupabaseClient,
  businessId: string,
  key: string
): Promise<string | null> {
  const lookup = db.from("contacts").select("id").eq("business_id", businessId);
  const aliasFilter = contactAliasOrFilter(key);
  const { data, error } = await (aliasFilter
    ? lookup.or(aliasFilter)
    : lookup.eq("customer_e164", key)
  ).maybeSingle();
  if (error) throw new Error(`findContactIdByKey: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * FUB person ids -> our contact ids for note/deal linkage, hydrating unknown
 * ids in batches of 100 through the people id filter. `null` means the
 * person has no matching contact (skipped person, or added to FUB mid-run).
 */
async function resolveContactIds(
  db: SupabaseClient,
  client: FubClient,
  businessId: string,
  personIds: number[],
  cache: Map<number, string | null>
): Promise<Map<number, string | null>> {
  const missing = [...new Set(personIds)].filter((id) => !cache.has(id));
  for (let i = 0; i < missing.length; i += FUB_PAGE_LIMIT) {
    const chunk = missing.slice(i, i + FUB_PAGE_LIMIT);
    const page = await client.getPeopleByIds(chunk, RESOLVE_FIELDS);
    const byId = new Map(page.items.map((p) => [p.id, p]));
    for (const id of chunk) {
      const person = byId.get(id);
      const mapped = person ? mapFubPerson(person) : null;
      if (!mapped?.ok) {
        cache.set(id, null);
        continue;
      }
      cache.set(id, await findContactIdByKey(db, businessId, mapped.value.key));
    }
  }
  return cache;
}

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

export type FubRunChunkResult = {
  status: "running" | "done";
  counts: FubRunCounts;
  cursor: FubImportCursor;
};

/**
 * Run import pages until the phase machine reaches `done` or the deadline
 * passes. Progress (counts + cursor) persists to the job row after EVERY
 * page, so the caller can simply invoke this again to continue; a fresh
 * call after `done` is a cheap no-op that re-persists the final state.
 */
export async function runFubImportChunk(
  db: SupabaseClient,
  client: FubClient,
  job: FubImportJobRow,
  opts: { deadlineMs: number; now?: () => number; pageSize?: number }
): Promise<FubRunChunkResult> {
  const now = opts.now ?? Date.now;
  const pageSize = opts.pageSize ?? FUB_PAGE_LIMIT;
  const cursor = normalizeFubCursor(job.cursor);
  const counts = normalizeFubRunCounts((job.counts as { run?: unknown }).run);
  const personCache = new Map<number, string | null>();

  // Claim the job as a REAL run BEFORE the first FUB call. dry_run is the
  // only thing that tells a preview apart from an import, and both the run
  // route and the dashboard refuse to resume a failed job that still looks
  // like a preview. Flipping it at the first page persist instead would
  // strand any run that dies on its opening page (a FUB timeout, a 500):
  // the job would be unresumable even though later pages may already have
  // written contacts, and starting a fresh job re-fires every contact event
  // (the dedupe keys are job-scoped), running automations a second time.
  // One write, only on the first chunk of a job: after that dry_run is
  // already false.
  if (job.dry_run) {
    await updateFubImportJob(db, job.business_id, job.id, {
      status: "running",
      dry_run: false,
      error: null
    });
  }

  const persist = async () => {
    await updateFubImportJob(db, job.business_id, job.id, {
      status: cursor.phase === "done" ? "done" : "running",
      dry_run: false,
      counts: { ...job.counts, run: counts },
      cursor,
      error: null
    });
  };

  let pagesRun = 0;
  while (cursor.phase !== "done" && now() < opts.deadlineMs) {
    if (cursor.phase === "people") {
      const page = await client.getPeople({
        limit: pageSize,
        next: cursor.next ?? undefined,
        offset: cursor.offset,
        fields: PEOPLE_FIELDS
      });
      for (const person of page.items) {
        const mapped = mapFubPerson(person);
        if (!mapped.ok) {
          counts.contactsSkipped += 1;
          recordFailure(counts, "person", mapped.reason);
          continue;
        }
        try {
          const outcome = await importOnePerson(db, job.business_id, job.id, mapped.value);
          if (outcome === "created") counts.contactsCreated += 1;
          else counts.contactsUpdated += 1;
        } catch (e) {
          counts.contactsSkipped += 1;
          recordFailure(
            counts,
            "person",
            `person ${person.id}: ${e instanceof Error ? e.message : "unexpected error"}`
          );
        }
      }
      advanceCursor(cursor, page, "notes");
    } else if (cursor.phase === "notes") {
      const page = await client.getNotes({
        limit: pageSize,
        next: cursor.next ?? undefined,
        offset: cursor.offset
      });
      const personIds = page.items
        .map((n) => n.personId)
        .filter((id): id is number => typeof id === "number");
      await resolveContactIds(db, client, job.business_id, personIds, personCache);
      const nowIso = new Date().toISOString();
      const rows: Record<string, unknown>[] = [];
      for (const note of page.items) {
        const mapped = mapFubNote(note, nowIso);
        if (!mapped.ok) {
          counts.notesSkipped += 1;
          recordFailure(counts, "note", mapped.reason);
          continue;
        }
        const contactId =
          typeof note.personId === "number" ? personCache.get(note.personId) ?? null : null;
        if (!contactId) {
          counts.notesSkipped += 1;
          recordFailure(
            counts,
            "note",
            `note ${note.id}: no matching contact for person ${note.personId ?? "none"}`
          );
          continue;
        }
        rows.push({
          business_id: job.business_id,
          contact_id: contactId,
          author_user_id: null,
          ...mapped.value
        });
      }
      if (rows.length > 0) {
        const { error } = await db
          .from("contact_notes")
          .upsert(rows, { onConflict: "business_id,external_source,external_id" });
        if (error) throw new Error(`notes upsert: ${error.message}`);
        counts.notesImported += rows.length;
      }
      advanceCursor(cursor, page, "deals");
    } else {
      if (!cursor.dealStages) {
        // stageId -> name across every pipeline, cached on the cursor so a
        // resumed run never re-fetches it.
        const pipelines = await listAllPages((p) => client.getPipelines(p), INVENTORY_MAX_PAGES);
        const stageNames: Record<string, string> = {};
        for (const pipeline of pipelines) {
          for (const stage of pipeline.stages ?? []) {
            if (stage?.id != null && stage.name) stageNames[String(stage.id)] = stage.name;
          }
        }
        cursor.dealStages = stageNames;
      }
      const page = await client.getDeals({
        limit: pageSize,
        next: cursor.next ?? undefined,
        offset: cursor.offset
      });
      const personIds = page.items
        .map((d) => d.people?.[0]?.id)
        .filter((id): id is number => typeof id === "number");
      await resolveContactIds(db, client, job.business_id, personIds, personCache);
      const nowIso = new Date().toISOString();
      const rows: Record<string, unknown>[] = [];
      for (const deal of page.items) {
        const mapped = mapFubDeal(deal, cursor.dealStages, nowIso);
        if (!mapped.ok) {
          counts.dealsSkipped += 1;
          recordFailure(counts, "deal", mapped.reason);
          continue;
        }
        const { personId, ...dealRow } = mapped.value;
        // A deal whose person cannot be resolved still imports, unlinked
        // (deals.contact_id is nullable; the board shows it without a name).
        const contactId = personId !== null ? personCache.get(personId) ?? null : null;
        rows.push({
          business_id: job.business_id,
          contact_id: contactId,
          created_by: null,
          ...dealRow
        });
      }
      if (rows.length > 0) {
        const { error } = await db
          .from("deals")
          .upsert(rows, { onConflict: "business_id,external_source,external_id" });
        if (error) throw new Error(`deals upsert: ${error.message}`);
        counts.dealsImported += rows.length;
      }
      advanceCursor(cursor, page, "done");
    }
    pagesRun += 1;
    await persist();
  }

  // Zero pages (deadline already passed, or the job was already done):
  // persist once anyway so the row's status always reflects this call.
  if (pagesRun === 0) await persist();

  return { status: cursor.phase === "done" ? "done" : "running", counts, cursor };
}
