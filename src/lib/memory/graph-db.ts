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
  /** Content surface that created the node (kg-sources registry key). */
  source: string;
  /** Highest trust tier seen for this node (0-3; see kg-sources.ts). */
  trust: number;
  /** Who introduced it (caller E.164, email, platform id); null = owner-canonical. */
  attributed_to: string | null;
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
  /** Content surface that stated it (kg-sources registry key). */
  source: string;
  /** Trust tier of the statement (0-3; see kg-sources.ts). */
  trust: number;
  /** Who stated it; null = owner-canonical. */
  attributed_to: string | null;
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
    source?: string;
    trust?: number;
    attributed_to?: string | null;
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
  patch: {
    aliases?: string[];
    phones?: string[];
    emails?: string[];
    customer_e164?: string | null;
    trust?: number;
  },
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
    source?: string;
    trust?: number;
    attributed_to?: string | null;
  },
  client?: SupabaseClient
): Promise<MemoryFactRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.from("memory_facts").insert(fact).select().single();
  if (error) throw new Error(`insertMemoryFact: ${error.message}`);
  return data as MemoryFactRow;
}

/**
 * Re-stated fact: an identical (subject, predicate, object) landed again —
 * no new row, but stated_at bumps so recency reflects the latest
 * re-confirmation (repeat bookings, owners repeating rules).
 */
export async function touchMemoryFactStatedAt(
  id: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("memory_facts")
    .update({ stated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`touchMemoryFactStatedAt: ${error.message}`);
}

/**
 * Retire facts WITHOUT a successor (owner removed the source content, e.g.
 * a cleared pinned note): active=false, superseded_by stays null — which
 * distinguishes "withdrawn" from "replaced by a newer statement".
 */
export async function deactivateMemoryFacts(
  ids: string[],
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("memory_facts").update({ active: false }).in("id", ids);
  if (error) throw new Error(`deactivateMemoryFacts: ${error.message}`);
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

/** An EFFECTIVE graph mode (post-inheritance). */
export type MemoryGraphMode = "off" | "shadow" | "active";

/** What a business_configs row may hold ('inherit' follows the fleet default). */
export type MemoryGraphModeSetting = MemoryGraphMode | "inherit";

/** admin_platform_settings key holding the fleet-wide default mode. */
export const MEMORY_GRAPH_DEFAULT_MODE_KEY = "memory_graph_default_mode";

/** Fleet default when the settings key was never written. */
export const MEMORY_GRAPH_FALLBACK_DEFAULT: MemoryGraphMode = "shadow";

/**
 * ~60s module cache for the fleet default: the resolver sits on the voice
 * knowledge lookup's 3s deadline, so the settings row must not cost a DB
 * round-trip per call.
 */
const DEFAULT_MODE_CACHE_TTL_MS = 60_000;
let defaultModeCache: { value: MemoryGraphMode; at: number } | null = null;

/** Tests only: drop the fleet-default cache between cases. */
export function resetMemoryGraphDefaultCache(): void {
  defaultModeCache = null;
}

function asMode(value: unknown): MemoryGraphMode | null {
  return value === "off" || value === "shadow" || value === "active" ? value : null;
}

export type ResolveModeDeps = {
  /** Injectable settings read (tests). */
  getSetting?: (key: string) => Promise<unknown | null>;
  now?: () => number;
};

/**
 * The fleet-wide default graph mode (admin-set on /admin/memory-graph),
 * cached ~60s. A missing or malformed setting falls back to 'shadow'.
 */
export async function getMemoryGraphDefaultMode(
  deps: ResolveModeDeps = {}
): Promise<MemoryGraphMode> {
  /* c8 ignore start -- production defaults; tests inject */
  const getSetting =
    deps.getSetting ??
    (async (key: string) => {
      const { getAdminPlatformSetting } = await import("@/lib/admin/platform-settings");
      return getAdminPlatformSetting(key);
    });
  /* c8 ignore stop */
  const now = (deps.now ?? Date.now)();
  if (defaultModeCache && now - defaultModeCache.at < DEFAULT_MODE_CACHE_TTL_MS) {
    return defaultModeCache.value;
  }
  let value: MemoryGraphMode = MEMORY_GRAPH_FALLBACK_DEFAULT;
  try {
    value = asMode(await getSetting(MEMORY_GRAPH_DEFAULT_MODE_KEY)) ?? MEMORY_GRAPH_FALLBACK_DEFAULT;
  } catch {
    // Settings-table blip: serve the fallback and retry after the TTL.
  }
  defaultModeCache = { value, at: now };
  return value;
}

/**
 * Pure inheritance step: explicit off/shadow/active as-is; 'inherit' (or
 * absent/unknown — rows predating the migration) follows the supplied
 * fleet default. Admin views use this with a FRESHLY-READ default so a
 * single page render can never mix cached and fresh values.
 */
export function effectiveMemoryGraphMode(
  configValue: string | null | undefined,
  fleetDefault: MemoryGraphMode
): MemoryGraphMode {
  return asMode(configValue) ?? fleetDefault;
}

/**
 * Resolve a business_configs.memory_graph_mode value to the EFFECTIVE mode:
 * explicit off/shadow/active as-is; 'inherit' (or absent/unknown — rows
 * predating the migration) follows the fleet default (cached ~60s).
 */
export async function resolveMemoryGraphMode(
  configValue: string | null | undefined,
  deps: ResolveModeDeps = {}
): Promise<MemoryGraphMode> {
  const explicit = asMode(configValue);
  if (explicit) return explicit;
  return getMemoryGraphDefaultMode(deps);
}

/** The tenant's EFFECTIVE graph rollout mode (inheritance resolved). */
export async function getMemoryGraphMode(
  businessId: string,
  client?: SupabaseClient
): Promise<MemoryGraphMode> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_configs")
    .select("memory_graph_mode")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getMemoryGraphMode: ${error.message}`);
  const raw = (data as { memory_graph_mode?: string } | null)?.memory_graph_mode;
  return resolveMemoryGraphMode(raw);
}
