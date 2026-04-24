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
