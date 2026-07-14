/**
 * Supabase access for pipelines + stages (service-role only; authorization
 * is the API route's job via requireBusinessRole, same trust model as the
 * customers/employees db modules).
 *
 * Stage renames/deletes RETAG the affected contacts (the stage IS its tag),
 * but deliberately do NOT fire tag_changed contact events: those bulk
 * operations are board administration, not per-lead state transitions —
 * firing automation for hundreds of contacts on a rename would be a
 * foot-gun. The single-contact stage MOVE (the drag-and-drop path) does
 * fire the hooks; that lives in its API route.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { normalizeContactTags } from "@/lib/customer-memory/types";
import {
  MAX_PIPELINES_PER_BUSINESS,
  MAX_STAGES_PER_PIPELINE,
  MAX_PIPELINE_NAME_LENGTH,
  MAX_STAGE_NAME_LENGTH,
  normalizeStageColor,
  type Pipeline,
  type PipelineStage
} from "./types";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Typed failure the API routes map onto 4xx responses. */
export class PipelineError extends Error {
  constructor(
    public readonly code: "not_found" | "limit" | "duplicate" | "invalid",
    message: string
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

/**
 * How many tagged contacts a bulk retag scans. Tag matching is
 * case-insensitive, which PostgREST array operators can't express, so we
 * pull the tagged rows and filter in process — bounded to keep the
 * operation predictable on tag-heavy tenants.
 */
export const RETAG_SCAN_LIMIT = 2000;

type PipelineRow = { id: string; business_id: string; name: string; position: number };
type StageRow = {
  id: string;
  pipeline_id: string;
  name: string;
  color: string;
  position: number;
};

const PIPELINE_COLUMNS = "id, business_id, name, position";
const STAGE_COLUMNS = "id, pipeline_id, name, color, position";

function toStage(row: StageRow): PipelineStage {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    name: row.name,
    color: normalizeStageColor(row.color),
    position: row.position
  };
}

/** Validate a stage-name candidate (it will become a contact tag). */
function cleanStageName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > MAX_STAGE_NAME_LENGTH) {
    throw new PipelineError(
      "invalid",
      `Stage names must be 1–${MAX_STAGE_NAME_LENGTH} characters.`
    );
  }
  return name;
}

function cleanPipelineName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > MAX_PIPELINE_NAME_LENGTH) {
    throw new PipelineError(
      "invalid",
      `Pipeline names must be 1–${MAX_PIPELINE_NAME_LENGTH} characters.`
    );
  }
  return name;
}

/** Every pipeline for a business, stages ordered, board order. */
export async function listPipelines(
  businessId: string,
  client?: SupabaseClient
): Promise<Pipeline[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: pipeRows, error: pipeErr } = await db
    .from("pipelines")
    .select(PIPELINE_COLUMNS)
    .eq("business_id", businessId)
    .order("position", { ascending: true });
  if (pipeErr) throw new Error(`listPipelines: ${pipeErr.message}`);
  const pipelines = (pipeRows ?? []) as PipelineRow[];
  if (pipelines.length === 0) return [];

  const { data: stageRows, error: stageErr } = await db
    .from("pipeline_stages")
    .select(STAGE_COLUMNS)
    .eq("business_id", businessId)
    .in("pipeline_id", pipelines.map((p) => p.id))
    .order("position", { ascending: true });
  if (stageErr) throw new Error(`listPipelines: stages: ${stageErr.message}`);

  const stagesByPipeline = new Map<string, PipelineStage[]>();
  for (const row of (stageRows ?? []) as StageRow[]) {
    const list = stagesByPipeline.get(row.pipeline_id) ?? [];
    list.push(toStage(row));
    stagesByPipeline.set(row.pipeline_id, list);
  }

  return pipelines.map((p) => ({
    id: p.id,
    businessId: p.business_id,
    name: p.name,
    position: p.position,
    stages: stagesByPipeline.get(p.id) ?? []
  }));
}

/**
 * Create a pipeline with its initial ordered stages. Caps + duplicate stage
 * names rejected up front; a stage-insert failure rolls the pipeline row
 * back (best effort) so no half-created board survives.
 */
export async function createPipeline(
  businessId: string,
  name: string,
  stages: Array<{ name: string; color?: string }>,
  client?: SupabaseClient
): Promise<Pipeline> {
  const db = client ?? (await createSupabaseServiceClient());
  const pipelineName = cleanPipelineName(name);
  const stageCountValid = stages.length > 0 && stages.length <= MAX_STAGES_PER_PIPELINE;
  if (!stageCountValid) {
    throw new PipelineError(
      "invalid",
      `A pipeline needs 1–${MAX_STAGES_PER_PIPELINE} stages.`
    );
  }
  const cleaned = stages.map((s) => ({
    name: cleanStageName(s.name),
    color: normalizeStageColor(s.color)
  }));
  const keys = cleaned.map((s) => s.name.toLowerCase());
  if (new Set(keys).size !== keys.length) {
    throw new PipelineError("duplicate", "Stage names must be unique within a pipeline.");
  }

  const { data: existing, error: countErr } = await db
    .from("pipelines")
    .select("id")
    .eq("business_id", businessId);
  if (countErr) throw new Error(`createPipeline: count: ${countErr.message}`);
  const count = (existing ?? []).length;
  if (count >= MAX_PIPELINES_PER_BUSINESS) {
    throw new PipelineError(
      "limit",
      `A business can have at most ${MAX_PIPELINES_PER_BUSINESS} pipelines.`
    );
  }

  const { data: pipeRow, error: insErr } = await db
    .from("pipelines")
    .insert({ business_id: businessId, name: pipelineName, position: count })
    .select(PIPELINE_COLUMNS)
    .single();
  if (insErr || !pipeRow) {
    // The unique (business_id, lower(name)) index rejects duplicates (23505).
    if ((insErr as { code?: string } | null)?.code === "23505") {
      throw new PipelineError(
        "duplicate",
        `A pipeline named "${pipelineName}" already exists.`
      );
    }
    throw new Error(`createPipeline: ${insErr?.message ?? "insert returned no row"}`);
  }
  const pipeline = pipeRow as PipelineRow;

  const { data: stageRows, error: stageErr } = await db
    .from("pipeline_stages")
    .insert(
      cleaned.map((s, i) => ({
        pipeline_id: pipeline.id,
        business_id: businessId,
        name: s.name,
        color: s.color,
        position: i
      }))
    )
    .select(STAGE_COLUMNS);
  if (stageErr) {
    // Best-effort rollback; the thrown error is the one that matters.
    await db.from("pipelines").delete().eq("id", pipeline.id);
    throw new Error(`createPipeline: stages: ${stageErr.message}`);
  }

  return {
    id: pipeline.id,
    businessId: pipeline.business_id,
    name: pipeline.name,
    position: pipeline.position,
    stages: ((stageRows ?? []) as StageRow[])
      .map(toStage)
      .sort((a, b) => a.position - b.position)
  };
}

/** Rename a pipeline (stages/tags untouched). */
export async function renamePipeline(
  businessId: string,
  pipelineId: string,
  name: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const pipelineName = cleanPipelineName(name);
  const { data, error } = await db
    .from("pipelines")
    .update({ name: pipelineName, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", pipelineId)
    .select("id");
  if (error) throw new Error(`renamePipeline: ${error.message}`);
  if ((data ?? []).length === 0) {
    throw new PipelineError("not_found", "Pipeline not found.");
  }
}

/**
 * Delete a pipeline (stages cascade). Contacts keep their tags — the board
 * view disappears, the underlying state does not.
 */
export async function deletePipeline(
  businessId: string,
  pipelineId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("pipelines")
    .delete()
    .eq("business_id", businessId)
    .eq("id", pipelineId)
    .select("id");
  if (error) throw new Error(`deletePipeline: ${error.message}`);
  if ((data ?? []).length === 0) {
    throw new PipelineError("not_found", "Pipeline not found.");
  }
}

/** The stages of one pipeline (ordered), asserting tenant ownership. */
async function getStages(
  db: SupabaseClient,
  businessId: string,
  pipelineId: string
): Promise<StageRow[]> {
  const { data, error } = await db
    .from("pipeline_stages")
    .select(STAGE_COLUMNS)
    .eq("business_id", businessId)
    .eq("pipeline_id", pipelineId)
    .order("position", { ascending: true });
  if (error) throw new Error(`pipeline stages: ${error.message}`);
  return (data ?? []) as StageRow[];
}

/** Add a stage at the end of the board. */
export async function addStage(
  businessId: string,
  pipelineId: string,
  stage: { name: string; color?: string },
  client?: SupabaseClient
): Promise<PipelineStage> {
  const db = client ?? (await createSupabaseServiceClient());
  const name = cleanStageName(stage.name);
  const siblings = await getStages(db, businessId, pipelineId);
  if (siblings.length >= MAX_STAGES_PER_PIPELINE) {
    throw new PipelineError(
      "limit",
      `A pipeline can have at most ${MAX_STAGES_PER_PIPELINE} stages.`
    );
  }
  if (siblings.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    throw new PipelineError("duplicate", `A stage named "${name}" already exists.`);
  }
  const position = siblings.length === 0 ? 0 : siblings[siblings.length - 1]!.position + 1;
  const { data, error } = await db
    .from("pipeline_stages")
    .insert({
      pipeline_id: pipelineId,
      business_id: businessId,
      name,
      color: normalizeStageColor(stage.color),
      position
    })
    .select(STAGE_COLUMNS)
    .single();
  if (error || !data) {
    throw new Error(`addStage: ${error?.message ?? "insert returned no row"}`);
  }
  return toStage(data as StageRow);
}

/** One stage row by id, tenant-scoped. */
async function getStage(
  db: SupabaseClient,
  businessId: string,
  stageId: string
): Promise<StageRow> {
  const { data, error } = await db
    .from("pipeline_stages")
    .select(STAGE_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", stageId)
    .maybeSingle();
  if (error) throw new Error(`pipeline stage: ${error.message}`);
  if (!data) throw new PipelineError("not_found", "Stage not found.");
  return data as StageRow;
}

/**
 * Swap `fromTag` for `toTag` on every tagged contact of the business.
 * Case-insensitive; bounded by {@link RETAG_SCAN_LIMIT}. Returns the number
 * of contacts updated.
 */
async function retagContacts(
  db: SupabaseClient,
  businessId: string,
  fromTag: string,
  toTag: string
): Promise<number> {
  const { data, error } = await db
    .from("contacts")
    .select("id, tags")
    .eq("business_id", businessId)
    .neq("tags", "{}")
    .limit(RETAG_SCAN_LIMIT);
  if (error) throw new Error(`retagContacts: ${error.message}`);
  const fromKey = fromTag.trim().toLowerCase();
  let updated = 0;
  for (const row of (data ?? []) as Array<{ id: string; tags: string[] | null }>) {
    const tags = Array.isArray(row.tags) ? row.tags : [];
    if (!tags.some((t) => t.trim().toLowerCase() === fromKey)) continue;
    const kept = tags.filter((t) => t.trim().toLowerCase() !== fromKey);
    const next = normalizeContactTags([...kept, toTag]);
    const { error: updErr } = await db
      .from("contacts")
      .update({ tags: next, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (updErr) throw new Error(`retagContacts: update: ${updErr.message}`);
    updated += 1;
  }
  return updated;
}

/**
 * Rename and/or recolor a stage. A REAL rename (case-insensitive change)
 * retags every contact carrying the old tag onto the new one so nobody
 * falls off the board; a pure case/spacing respelling still updates the
 * stored name but needs no retag (tag matching is case-insensitive).
 */
export async function updateStage(
  businessId: string,
  stageId: string,
  patch: { name?: string; color?: string },
  client?: SupabaseClient
): Promise<{ stage: PipelineStage; retagged: number }> {
  const db = client ?? (await createSupabaseServiceClient());
  const stage = await getStage(db, businessId, stageId);

  const updates: Record<string, string> = { updated_at: new Date().toISOString() };
  let renamedFrom: string | null = null;
  if (patch.name !== undefined) {
    const name = cleanStageName(patch.name);
    if (name !== stage.name) {
      const siblings = await getStages(db, businessId, stage.pipeline_id);
      if (
        siblings.some(
          (s) => s.id !== stageId && s.name.toLowerCase() === name.toLowerCase()
        )
      ) {
        throw new PipelineError("duplicate", `A stage named "${name}" already exists.`);
      }
      if (name.toLowerCase() !== stage.name.toLowerCase()) renamedFrom = stage.name;
      updates.name = name;
    }
  }
  if (patch.color !== undefined) updates.color = normalizeStageColor(patch.color);

  const { data, error } = await db
    .from("pipeline_stages")
    .update(updates)
    .eq("business_id", businessId)
    .eq("id", stageId)
    .select(STAGE_COLUMNS)
    .single();
  if (error || !data) {
    throw new Error(`updateStage: ${error?.message ?? "update returned no row"}`);
  }

  const retagged = renamedFrom
    ? await retagContacts(db, businessId, renamedFrom, updates.name!)
    : 0;
  return { stage: toStage(data as StageRow), retagged };
}

/**
 * Reorder a pipeline's stages. `orderedIds` must be exactly the pipeline's
 * current stage ids (a permutation) — anything else is a stale board.
 */
export async function reorderStages(
  businessId: string,
  pipelineId: string,
  orderedIds: string[],
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const stages = await getStages(db, businessId, pipelineId);
  const current = new Set(stages.map((s) => s.id));
  if (
    orderedIds.length !== stages.length ||
    !orderedIds.every((id) => current.has(id)) ||
    new Set(orderedIds).size !== orderedIds.length
  ) {
    throw new PipelineError(
      "invalid",
      "Stage order must include each existing stage exactly once."
    );
  }
  for (let i = 0; i < orderedIds.length; i++) {
    const { error } = await db
      .from("pipeline_stages")
      .update({ position: i, updated_at: new Date().toISOString() })
      .eq("business_id", businessId)
      .eq("id", orderedIds[i]!);
    if (error) throw new Error(`reorderStages: ${error.message}`);
  }
}

/**
 * Delete a stage. With a destination (must be a DIFFERENT stage of the SAME
 * pipeline), contacts in the deleted stage are moved there (GHL's "move
 * opportunities to another stage"); with null, the stage column disappears
 * and contacts simply keep the now-unmapped tag.
 */
export async function deleteStage(
  businessId: string,
  stageId: string,
  destinationStageId: string | null,
  client?: SupabaseClient
): Promise<{ retagged: number }> {
  const db = client ?? (await createSupabaseServiceClient());
  const stage = await getStage(db, businessId, stageId);

  let destination: StageRow | null = null;
  if (destinationStageId) {
    if (destinationStageId === stageId) {
      throw new PipelineError("invalid", "Destination must be a different stage.");
    }
    destination = await getStage(db, businessId, destinationStageId);
    if (destination.pipeline_id !== stage.pipeline_id) {
      throw new PipelineError("invalid", "Destination must be on the same pipeline.");
    }
  }

  const { error } = await db
    .from("pipeline_stages")
    .delete()
    .eq("business_id", businessId)
    .eq("id", stageId);
  if (error) throw new Error(`deleteStage: ${error.message}`);

  const retagged = destination
    ? await retagContacts(db, businessId, stage.name, destination.name)
    : 0;
  return { retagged };
}
