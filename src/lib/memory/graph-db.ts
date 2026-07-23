/**
 * Thin PostgREST wrappers for the memory knowledge graph tables
 * (memory_entities / memory_facts — see the 20260820100100_memory_graph
 * migration). Service-role only, same posture as the other tenant-content
 * tables. Resolution/supersedence LOGIC lives in graph-write.ts; this module
 * pins the wire-level shapes.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type MemoryEntityRow = {
  id: string;
  business_id: string;
  kind: string;
  canonical_name: string;
  aliases: string[];
  phones: string[];
  emails: string[];
  customer_e164: string | null;
  created_at: string;
  updated_at: string;
};

export type MemoryFactRow = {
  id: string;
  business_id: string;
  subject_entity_id: string;
  predicate: string;
  object_entity_id: string | null;
  object_value: string | null;
  source_text: string;
  stated_at: string;
  active: boolean;
  superseded_by: string | null;
  created_at: string;
};

export async function listMemoryEntities(
  businessId: string,
  client?: SupabaseClient
): Promise<MemoryEntityRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("memory_entities")
    .select()
    .eq("business_id", businessId);
  if (error) throw new Error(`listMemoryEntities: ${error.message}`);
  return (data ?? []) as MemoryEntityRow[];
}

export async function insertMemoryEntity(
  entity: {
    business_id: string;
    kind: string;
    canonical_name: string;
    aliases: string[];
    phones: string[];
    emails: string[];
    customer_e164?: string | null;
  },
  client?: SupabaseClient
): Promise<MemoryEntityRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.from("memory_entities").insert(entity).select().single();
  if (error) throw new Error(`insertMemoryEntity: ${error.message}`);
  return data as MemoryEntityRow;
}

export async function updateMemoryEntity(
  id: string,
  patch: { aliases?: string[]; phones?: string[]; emails?: string[]; customer_e164?: string | null },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("memory_entities")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`updateMemoryEntity: ${error.message}`);
}

/** Every active fact for a business — the retrieval working set. */
export async function listActiveFactsForBusiness(
  businessId: string,
  client?: SupabaseClient
): Promise<MemoryFactRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("memory_facts")
    .select()
    .eq("business_id", businessId)
    .eq("active", true);
  if (error) throw new Error(`listActiveFactsForBusiness: ${error.message}`);
  return (data ?? []) as MemoryFactRow[];
}

/** Active facts for one subject+predicate — the supersedence lookup. */
export async function listActiveFacts(
  businessId: string,
  subjectEntityId: string,
  predicate: string,
  client?: SupabaseClient
): Promise<MemoryFactRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("memory_facts")
    .select()
    .eq("business_id", businessId)
    .eq("subject_entity_id", subjectEntityId)
    .eq("predicate", predicate)
    .eq("active", true);
  if (error) throw new Error(`listActiveFacts: ${error.message}`);
  return (data ?? []) as MemoryFactRow[];
}

export async function insertMemoryFact(
  fact: {
    business_id: string;
    subject_entity_id: string;
    predicate: string;
    object_entity_id?: string | null;
    object_value?: string | null;
    source_text: string;
  },
  client?: SupabaseClient
): Promise<MemoryFactRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.from("memory_facts").insert(fact).select().single();
  if (error) throw new Error(`insertMemoryFact: ${error.message}`);
  return data as MemoryFactRow;
}

/** Mark old facts inactive, pointing at the fact that replaced them. */
export async function supersedeMemoryFacts(
  ids: string[],
  supersededBy: string,
  client?: SupabaseClient
): Promise<void> {
  if (ids.length === 0) return;
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("memory_facts")
    .update({ active: false, superseded_by: supersededBy })
    .in("id", ids);
  if (error) throw new Error(`supersedeMemoryFacts: ${error.message}`);
}

/** The tenant's graph rollout mode: off (default) | shadow | active. */
export async function getMemoryGraphMode(
  businessId: string,
  client?: SupabaseClient
): Promise<"off" | "shadow" | "active"> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_configs")
    .select("memory_graph_mode")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getMemoryGraphMode: ${error.message}`);
  const mode = (data as { memory_graph_mode?: string } | null)?.memory_graph_mode;
  return mode === "shadow" || mode === "active" ? mode : "off";
}
