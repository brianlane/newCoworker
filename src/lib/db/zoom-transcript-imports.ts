/**
 * Idempotency ledger for Zoom transcript imports (`zoom_transcript_imports`,
 * service-role only: RLS on, zero policies).
 *
 * One row per (business, meeting UUID). The webhook path CLAIMS before it
 * imports so Zoom's delivery retries and manual-then-webhook overlap
 * collapse to one document; a claim that fails downstream is RELEASED so
 * the retry (or the owner) can try again. Manual imports record their row
 * best-effort AFTER succeeding: they are never blocked by the ledger,
 * because the owner asked explicitly.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

const UNIQUE_VIOLATION = "23505";

/**
 * Claim the (business, meeting) slot. Returns false when another delivery
 * already holds it (unique-violation), which callers treat as "duplicate,
 * skip quietly".
 */
export async function claimZoomTranscriptImport(
  businessId: string,
  meetingUuid: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("zoom_transcript_imports")
    .insert({ business_id: businessId, meeting_uuid: meetingUuid });
  if (!error) return true;
  if (error.code === UNIQUE_VIOLATION) return false;
  throw new Error(`claimZoomTranscriptImport: ${error.message}`);
}

/**
 * Client resolution for the best-effort paths below: they must never throw,
 * and the only throw source on these paths is service-client creation (the
 * PostgREST builder reports failures as `{ error }`, not rejections). Null
 * means "skip the write and log", keeping release/finalize/record silent.
 */
async function ledgerClientOrNull(
  client: SupabaseClient | undefined,
  op: string
): Promise<SupabaseClient | null> {
  if (client) return client;
  try {
    return await createSupabaseServiceClient();
  } catch (err) {
    logger.warn(`zoom transcript ledger: ${op} client unavailable`, {
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Release a claim whose import failed, so Zoom's webhook retry (or a later
 * manual import) gets a clean slot. Never throws: releasing is best-effort
 * cleanup on an already-failing path, and a stale leftover claim only
 * suppresses a duplicate.
 */
export async function releaseZoomTranscriptImport(
  businessId: string,
  meetingUuid: string,
  client?: SupabaseClient
): Promise<void> {
  const db = await ledgerClientOrNull(client, "release");
  if (!db) return;
  const { error } = await db
    .from("zoom_transcript_imports")
    .delete()
    .match({ business_id: businessId, meeting_uuid: meetingUuid })
    .is("document_id", null);
  if (error) {
    logger.warn("zoom transcript ledger: release failed", {
      businessId,
      error: error.message
    });
  }
}

/** Stamp the produced document onto the claim (ops trail). Best-effort. */
export async function finalizeZoomTranscriptImport(
  businessId: string,
  meetingUuid: string,
  documentId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = await ledgerClientOrNull(client, "finalize");
  if (!db) return;
  const { error } = await db
    .from("zoom_transcript_imports")
    .update({ document_id: documentId })
    .match({ business_id: businessId, meeting_uuid: meetingUuid });
  if (error) {
    logger.warn("zoom transcript ledger: finalize failed", {
      businessId,
      error: error.message
    });
  }
}

/**
 * Best-effort record from the MANUAL import path (after success), so a
 * later webhook delivery for the same meeting becomes a no-op. Duplicate
 * rows are fine to lose; never throws (worst case: the webhook later
 * imports a duplicate the owner deletes).
 */
export async function recordManualZoomTranscriptImport(
  businessId: string,
  meetingUuid: string,
  documentId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = await ledgerClientOrNull(client, "manual record");
  if (!db) return;
  const { error } = await db.from("zoom_transcript_imports").insert({
    business_id: businessId,
    meeting_uuid: meetingUuid,
    document_id: documentId
  });
  if (error && error.code !== UNIQUE_VIOLATION) {
    logger.warn("zoom transcript ledger: manual record failed", {
      businessId,
      error: error.message
    });
  }
}
