/**
 * AiFlow definition history: read it, and undo an edit with it.
 *
 * Every definition or name change to `ai_flows` appends the PRIOR state to
 * `ai_flow_definition_versions` (trigger, migration 20260822182135), so this
 * module never has to be the thing that remembers to snapshot. It only
 * reads that history and writes an old state back.
 *
 * Restoring goes through `updateAiFlow` on purpose rather than writing the
 * table directly: the restore is itself an edit, so it validates like any
 * other and the trigger snapshots the state being replaced. Undo is
 * therefore undoable, and a restore that turns out to be the wrong one is
 * not a second unrecoverable event.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { updateAiFlow, type AiFlowRow } from "@/lib/ai-flows/db";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Newest-first history page size. Undo only ever needs the head. */
export const FLOW_VERSION_LIST_LIMIT = 20;

const VERSION_COLS = "id,flow_id,business_id,definition,name,enabled,source,actor,replaced_at";

export type AiFlowVersionRow = {
  id: number;
  flow_id: string;
  business_id: string;
  /** The definition as it was BEFORE the edit this row records. */
  definition: AiFlowDefinition;
  name: string;
  enabled: boolean;
  /** Provenance of the edit that replaced the snapshot; null when unstamped. */
  source: string | null;
  actor: string | null;
  replaced_at: string;
};

async function resolveDb(client?: SupabaseClient): Promise<SupabaseClient> {
  /* c8 ignore next -- production default; tests inject */
  return client ?? (await createSupabaseServiceClient());
}

/**
 * Newest-first edit history for one flow. Scoped by business so a flow id
 * guessed from another tenant reads as empty rather than leaking.
 */
export async function listFlowVersions(
  businessId: string,
  flowId: string,
  opts: { limit?: number; client?: SupabaseClient } = {}
): Promise<AiFlowVersionRow[]> {
  const db = await resolveDb(opts.client);
  const limit = Math.max(1, Math.min(opts.limit ?? FLOW_VERSION_LIST_LIMIT, 100));
  const { data, error } = await db
    .from("ai_flow_definition_versions")
    .select(VERSION_COLS)
    .eq("business_id", businessId)
    .eq("flow_id", flowId)
    .order("replaced_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listFlowVersions: ${error.message}`);
  return (data ?? []) as AiFlowVersionRow[];
}

export type RestoreFlowVersionResult =
  | {
      ok: true;
      flowId: string;
      flowName: string;
      /** The history row that was written back. */
      versionId: number;
      /** When the restored state stopped being live. */
      replacedAt: string;
      /** Provenance of the edit being undone, when the writer stamped one. */
      undoneSource: string | null;
    }
  | { ok: false; message: string };

/**
 * Put a previous definition back. With no `versionId` this undoes the most
 * recent edit, which is the only form the owner-facing surfaces use.
 *
 * `enabled` is deliberately NOT restored: it is a separate control with its
 * own history (enabled_changed_at), and an undo that silently switched an
 * automation back on would be a bigger surprise than the edit it reverses.
 */
export async function restoreFlowVersion(
  businessId: string,
  flowId: string,
  opts: {
    versionId?: number;
    editSource?: string;
    editActor?: string | null;
    client?: SupabaseClient;
    /** Injectable cores (tests). */
    fetchVersions?: typeof listFlowVersions;
    persistUpdate?: typeof updateAiFlow;
  } = {}
): Promise<RestoreFlowVersionResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const fetchVersions = opts.fetchVersions ?? listFlowVersions;
  const persistUpdate = opts.persistUpdate ?? updateAiFlow;
  /* c8 ignore stop */

  const versions = await fetchVersions(businessId, flowId, {
    ...(opts.client ? { client: opts.client } : {})
  });
  if (versions.length === 0) {
    return {
      ok: false,
      message: "This automation has no earlier version recorded, so there is nothing to undo."
    };
  }

  const target =
    opts.versionId === undefined
      ? versions[0]
      : versions.find((row) => row.id === opts.versionId);
  if (!target) {
    return {
      ok: false,
      message: `Version ${opts.versionId} is not in this automation's recent history.`
    };
  }

  let restored: AiFlowRow;
  try {
    restored = await persistUpdate({
      businessId,
      id: flowId,
      name: target.name,
      definition: target.definition,
      ...(opts.editSource !== undefined ? { editSource: opts.editSource } : {}),
      ...(opts.editActor !== undefined ? { editActor: opts.editActor } : {})
    });
  } catch (err) {
    // Honest failure: the flow is byte-identical to before the attempt.
    return {
      ok: false,
      message: `The earlier version could not be restored (${
        err instanceof Error ? err.message : String(err)
      }). The automation was not changed.`
    };
  }

  return {
    ok: true,
    flowId,
    flowName: restored.name,
    versionId: target.id,
    replacedAt: target.replaced_at,
    undoneSource: target.source
  };
}
