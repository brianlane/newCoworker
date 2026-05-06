/**
 * Voice call transcript reads for the owner dashboard.
 *
 * Writes happen from the VPS bridge (see `vps/voice-bridge/src/voice-transcript.ts`);
 * this module is read-only and exists to keep `requireOwner()`-gated API routes thin.
 * Every helper scopes by `business_id` so one business can never read another's calls.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type VoiceTranscriptStatus = "in_progress" | "completed" | "errored";

export type VoiceTranscriptTurnRole = "caller" | "assistant";

export type VoiceCallTranscriptRow = {
  id: string;
  business_id: string;
  call_control_id: string;
  reservation_id: string | null;
  caller_e164: string | null;
  model: string;
  status: VoiceTranscriptStatus;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
};

export type VoiceCallTranscriptTurnRow = {
  id: number;
  transcript_id: string;
  role: VoiceTranscriptTurnRole;
  content: string;
  turn_index: number;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
};

/** Default list limit; callers can override up to `MAX_LIST_LIMIT`. */
export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;

export async function listTranscriptsForBusiness(
  businessId: string,
  options: { limit?: number } = {},
  client?: SupabaseClient
): Promise<VoiceCallTranscriptRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const requested = options.limit ?? DEFAULT_LIST_LIMIT;
  const limit = Math.min(Math.max(1, requested), MAX_LIST_LIMIT);
  const { data, error } = await db
    .from("voice_call_transcripts")
    .select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listTranscriptsForBusiness: ${error.message}`);
  return (data as VoiceCallTranscriptRow[] | null) ?? [];
}

export async function getTranscriptByCallControlId(
  businessId: string,
  callControlId: string,
  client?: SupabaseClient
): Promise<VoiceCallTranscriptRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("voice_call_transcripts")
    .select("*")
    .eq("business_id", businessId)
    .eq("call_control_id", callControlId)
    .maybeSingle();
  if (error) throw new Error(`getTranscriptByCallControlId: ${error.message}`);
  return (data as VoiceCallTranscriptRow | null) ?? null;
}

/**
 * Lookup a transcript by its row UUID, scoped to a business.
 *
 * The dashboard "Call history" UI links by row UUID rather than by Telnyx
 * `call_control_id` because the latter starts with `v3:` — and the literal
 * `:` is a URL sub-delim that Cloudflare/Vercel sometimes pre-decode before
 * Next.js matches the dynamic segment, producing a 404 on rows that exist
 * in the DB. UUID lookup avoids the encoding pitfall entirely.
 */
export async function getTranscriptById(
  businessId: string,
  id: string,
  client?: SupabaseClient
): Promise<VoiceCallTranscriptRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("voice_call_transcripts")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getTranscriptById: ${error.message}`);
  return (data as VoiceCallTranscriptRow | null) ?? null;
}

export async function listTurns(
  transcriptId: string,
  client?: SupabaseClient
): Promise<VoiceCallTranscriptTurnRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("voice_call_transcript_turns")
    .select("*")
    .eq("transcript_id", transcriptId)
    .order("turn_index", { ascending: true });
  if (error) throw new Error(`listTurns: ${error.message}`);
  return (data as VoiceCallTranscriptTurnRow[] | null) ?? [];
}

/**
 * Cross-link helper for the per-customer detail page (Phase 4b).
 *
 * Returns recent transcripts for one (business_id, caller_e164) pair,
 * newest first, capped at MAX_LIST_LIMIT. Only `caller_e164` matches —
 * outbound calls (caller is the business) aren't customer-attributable
 * here.
 *
 * Used by /dashboard/customers/[customerE164] to render an inline
 * "recent voice calls" section that deep-links into the per-call
 * transcript pages, mirroring how the SMS history section works.
 */
export async function listTranscriptsForCaller(
  businessId: string,
  callerE164: string,
  options: { limit?: number } = {},
  client?: SupabaseClient
): Promise<VoiceCallTranscriptRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const requested = options.limit ?? DEFAULT_LIST_LIMIT;
  const limit = Math.min(Math.max(1, requested), MAX_LIST_LIMIT);
  const { data, error } = await db
    .from("voice_call_transcripts")
    .select("*")
    .eq("business_id", businessId)
    .eq("caller_e164", callerE164)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error(`listTranscriptsForCaller: ${error.message}`);
  return (data as VoiceCallTranscriptRow[] | null) ?? [];
}

/**
 * All turns for the recent transcripts of one customer, joined and
 * flattened into chronological order (oldest first). Used by the
 * cross-channel summarizer (Phase 2) to render voice content into
 * the summarizer prompt alongside SMS history.
 *
 * Capped (default 5 calls × ~30 turns each ≈ 150 rows, hard ceiling
 * 500) so a noisy customer can't blow up the summarizer prompt
 * budget.
 */
export type VoiceCustomerTurn = {
  callStartedAt: string | null;
  role: VoiceTranscriptTurnRole;
  content: string;
  transcriptId: string;
};

export async function listVoiceTurnsForCustomer(
  businessId: string,
  callerE164: string,
  options: { maxCalls?: number; maxTurnsTotal?: number } = {},
  client?: SupabaseClient
): Promise<VoiceCustomerTurn[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const maxCalls = Math.min(Math.max(1, options.maxCalls ?? 5), 25);
  const maxTurnsTotal = Math.min(Math.max(1, options.maxTurnsTotal ?? 150), 500);
  const transcripts = await listTranscriptsForCaller(
    businessId,
    callerE164,
    { limit: maxCalls },
    db
  );
  if (transcripts.length === 0) return [];
  // One bulk SELECT for all transcript ids — much cheaper than N
  // round trips on the summarizer hot path.
  const ids = transcripts.map((t) => t.id);
  const { data, error } = await db
    .from("voice_call_transcript_turns")
    .select("transcript_id, role, content, started_at, turn_index")
    .in("transcript_id", ids)
    .order("turn_index", { ascending: true })
    .limit(maxTurnsTotal);
  if (error) throw new Error(`listVoiceTurnsForCustomer: ${error.message}`);
  type Row = {
    transcript_id: string;
    role: VoiceTranscriptTurnRole;
    content: string;
    started_at: string | null;
    turn_index: number;
  };
  const startedAtById = new Map(transcripts.map((t) => [t.id, t.started_at]));
  return ((data as Row[] | null) ?? [])
    .map((r) => ({
      callStartedAt: r.started_at ?? startedAtById.get(r.transcript_id) ?? null,
      role: r.role,
      content: r.content,
      transcriptId: r.transcript_id
    }))
    .sort((a, b) => {
      // Chronological: order calls by start time, turns by turn_index
      // within a call. The DB ordering above gives us turn_index but
      // the SELECT crosses transcripts; this sort fixes inter-call
      // ordering without an extra ORDER BY column.
      const aTs = a.callStartedAt ?? "";
      const bTs = b.callStartedAt ?? "";
      if (aTs !== bTs) return aTs < bTs ? -1 : 1;
      return 0;
    });
}
