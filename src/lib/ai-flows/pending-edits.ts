/**
 * Staging and single-use consumption of AiFlow edits awaiting an owner's yes.
 *
 * Schema and the reasoning for storing (rather than recompiling) the
 * definition: supabase/migrations/20260822182736_ai_flow_pending_edits.sql.
 */
import { randomUUID } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";
import type { EditRisk } from "@/lib/ai-flows/edit-diff";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * How long a staged edit stays confirmable. Long enough for a texting owner
 * to read a diff and reply, short enough that a "yes" typed tomorrow does
 * not apply a change described against a definition that has since moved.
 */
export const PENDING_EDIT_TTL_MINUTES = 15;

const PENDING_COLS =
  "id,business_id,flow_id,token,definition,new_name,summary,ambiguities,risk,base_updated_at,surface,actor,created_at,expires_at,consumed_at";

export type PendingEditRow = {
  id: string;
  business_id: string;
  flow_id: string;
  token: string;
  definition: AiFlowDefinition;
  new_name: string | null;
  summary: string[];
  ambiguities: string[];
  risk: EditRisk;
  base_updated_at: string;
  surface: string | null;
  actor: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
};

async function resolveDb(client?: SupabaseClient): Promise<SupabaseClient> {
  /* c8 ignore next -- production default; tests inject */
  return client ?? (await createSupabaseServiceClient());
}

/** Stage a compiled edit and return the token that will apply it. */
export async function stagePendingEdit(
  input: {
    businessId: string;
    flowId: string;
    definition: AiFlowDefinition;
    newName?: string | null;
    summary: string[];
    ambiguities: string[];
    risk: Exclude<EditRisk, "none">;
    baseUpdatedAt: string;
    surface?: string | null;
    actor?: string | null;
  },
  opts: { client?: SupabaseClient; now?: () => number } = {}
): Promise<PendingEditRow> {
  const db = await resolveDb(opts.client);
  /* c8 ignore next -- production default; tests inject */
  const nowMs = (opts.now ?? Date.now)();
  const { data, error } = await db
    .from("ai_flow_pending_edits")
    .insert({
      business_id: input.businessId,
      flow_id: input.flowId,
      token: randomUUID(),
      definition: input.definition,
      new_name: input.newName ?? null,
      summary: input.summary,
      ambiguities: input.ambiguities,
      risk: input.risk,
      base_updated_at: input.baseUpdatedAt,
      surface: input.surface ?? null,
      actor: input.actor ?? null,
      expires_at: new Date(nowMs + PENDING_EDIT_TTL_MINUTES * 60_000).toISOString()
    })
    .select(PENDING_COLS)
    .single();
  if (error) throw new Error(`stagePendingEdit: ${error.message}`);
  return data as PendingEditRow;
}

/**
 * Read a staged edit without claiming it.
 *
 * The validation checks a confirm has to make (right flow, still fresh, no
 * open questions) do not need the claim, and running them after it would
 * burn a single-use token on a refusal that wrote nothing.
 */
export async function peekPendingEdit(
  businessId: string,
  token: string,
  opts: { client?: SupabaseClient } = {}
): Promise<PendingEditRow | null> {
  const db = await resolveDb(opts.client);
  const { data, error } = await db
    .from("ai_flow_pending_edits")
    .select(PENDING_COLS)
    .eq("business_id", businessId)
    .eq("token", token)
    .maybeSingle();
  if (error) throw new Error(`peekPendingEdit: ${error.message}`);
  return (data ?? null) as PendingEditRow | null;
}

export type ConsumeResult =
  | { ok: true; row: PendingEditRow }
  | { ok: false; message: string };

/**
 * Claim a staged edit exactly once.
 *
 * The claim is a compare-and-swap in the WHERE clause, not a read followed
 * by a write: two confirmations arriving together must not both apply the
 * same staged definition. A PostgREST update matching zero rows reports no
 * error, so the `.select()` result is the only signal that the claim landed,
 * and a miss is diagnosed with a second read rather than guessed at.
 */
export async function consumePendingEdit(
  businessId: string,
  token: string,
  opts: { client?: SupabaseClient; now?: () => number } = {}
): Promise<ConsumeResult> {
  const db = await resolveDb(opts.client);
  /* c8 ignore next -- production default; tests inject */
  const nowIso = new Date((opts.now ?? Date.now)()).toISOString();

  const { data, error } = await db
    .from("ai_flow_pending_edits")
    .update({ consumed_at: nowIso })
    .eq("business_id", businessId)
    .eq("token", token)
    .is("consumed_at", null)
    .gt("expires_at", nowIso)
    .select(PENDING_COLS);
  if (error) throw new Error(`consumePendingEdit: ${error.message}`);

  const claimed = (data ?? []) as PendingEditRow[];
  if (claimed.length === 1) return { ok: true, row: claimed[0] };

  // Zero rows: say WHICH of the three reasons, so the model relays something
  // the owner can act on instead of a generic failure.
  const { data: existing } = await db
    .from("ai_flow_pending_edits")
    .select(PENDING_COLS)
    .eq("business_id", businessId)
    .eq("token", token)
    .maybeSingle();
  const row = (existing ?? null) as PendingEditRow | null;
  if (!row) {
    return {
      ok: false,
      message:
        "That change is not staged any more. Describe the change again to get a fresh summary, and do not tell the owner it was applied."
    };
  }
  if (row.consumed_at !== null) {
    return {
      ok: false,
      message: "That change was already applied once. It has NOT been applied a second time."
    };
  }
  return {
    ok: false,
    message:
      "That change was staged too long ago and expired without being applied. Describe it again to get a fresh summary."
  };
}
