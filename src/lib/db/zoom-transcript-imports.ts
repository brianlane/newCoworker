/**
 * Idempotency ledger for Zoom transcript imports (`zoom_transcript_imports`,
 * service-role only: RLS on, zero policies).
 *
 * One row per (business, meeting UUID). Both import paths CLAIM before
 * importing, so Zoom's delivery retries and manual/webhook overlap collapse
 * to one document; a claim that fails downstream is RELEASED so the retry
 * (or the owner) can try again, and an abandoned in-flight claim becomes
 * stealable after a lease window. A completed row never blocks an explicit
 * manual RE-import (the owner may have deleted the document); the route
 * repoints the row's document_id instead.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

const UNIQUE_VIOLATION = "23505";

/**
 * An in-flight claim (document_id still null) older than this is considered
 * abandoned (crash/timeout before release) and may be stolen by the next
 * claimant. Generously above the import route's 120s execution budget.
 */
export const ZOOM_IMPORT_CLAIM_LEASE_MS = 10 * 60 * 1000;

/**
 * Claim the (business, meeting) slot. Returns false when another delivery
 * already holds it (unique-violation), which callers treat as "duplicate,
 * skip quietly". A stale IN-FLIGHT claim (see ZOOM_IMPORT_CLAIM_LEASE_MS)
 * is stolen atomically instead, so a crash that skipped the release can
 * never permanently block a meeting's auto-import.
 */
export async function claimZoomTranscriptImport(
  businessId: string,
  meetingUuid: string,
  client?: SupabaseClient,
  now: () => number = Date.now
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("zoom_transcript_imports")
    .insert({ business_id: businessId, meeting_uuid: meetingUuid });
  if (!error) return true;
  if (error.code !== UNIQUE_VIOLATION) {
    throw new Error(`claimZoomTranscriptImport: ${error.message}`);
  }

  // Steal only an ABANDONED in-flight claim: document_id must still be
  // null and the row older than the lease. The conditional update is the
  // atomic arbiter when several retries race for the steal.
  const staleCutoffIso = new Date(now() - ZOOM_IMPORT_CLAIM_LEASE_MS).toISOString();
  const { data, error: stealError } = await db
    .from("zoom_transcript_imports")
    .update({ created_at: new Date(now()).toISOString() })
    .match({ business_id: businessId, meeting_uuid: meetingUuid })
    .is("document_id", null)
    .lt("created_at", staleCutoffIso)
    .select("id");
  if (stealError) {
    throw new Error(`claimZoomTranscriptImport steal: ${stealError.message}`);
  }
  return ((data as { id: string }[] | null)?.length ?? 0) > 0;
}

/**
 * The ledger row for a meeting, or null. The manual import route uses this
 * to distinguish "auto-import is mid-flight right now" (document_id null)
 * from "already imported once" (document_id set).
 */
export async function getZoomTranscriptImport(
  businessId: string,
  meetingUuid: string,
  client?: SupabaseClient
): Promise<{ document_id: string | null; created_at: string } | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("zoom_transcript_imports")
    .select("document_id,created_at")
    .match({ business_id: businessId, meeting_uuid: meetingUuid })
    .maybeSingle();
  if (error) throw new Error(`getZoomTranscriptImport: ${error.message}`);
  return (data as { document_id: string | null; created_at: string } | null) ?? null;
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

/**
 * Stamp the produced document onto the claim. Returns whether the stamp
 * landed: a claim left at document_id null after a SUCCESSFUL import is a
 * duplicate hazard (the lease steal would re-import the meeting), so
 * callers retry and escalate on a false return. Never throws.
 */
export async function finalizeZoomTranscriptImport(
  businessId: string,
  meetingUuid: string,
  documentId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = await ledgerClientOrNull(client, "finalize");
  if (!db) return false;
  const { error } = await db
    .from("zoom_transcript_imports")
    .update({ document_id: documentId })
    .match({ business_id: businessId, meeting_uuid: meetingUuid });
  if (error) {
    logger.warn("zoom transcript ledger: finalize failed", {
      businessId,
      error: error.message
    });
    return false;
  }
  return true;
}

/**
 * Serialize a deliberate manual RE-import of an already-completed meeting:
 * atomically flip the completed row back to in-flight (document_id null,
 * fresh lease), so exactly one concurrent re-import wins the claim and the
 * others see an in-flight row. Throws on query errors (the manual route's
 * error handling owns them).
 */
export async function reclaimCompletedZoomTranscriptImport(
  businessId: string,
  meetingUuid: string,
  client?: SupabaseClient,
  now: () => number = Date.now
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("zoom_transcript_imports")
    .update({ document_id: null, created_at: new Date(now()).toISOString() })
    .match({ business_id: businessId, meeting_uuid: meetingUuid })
    .not("document_id", "is", null)
    .select("id");
  if (error) {
    throw new Error(`reclaimCompletedZoomTranscriptImport: ${error.message}`);
  }
  return ((data as { id: string }[] | null)?.length ?? 0) > 0;
}
