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
  const { data, error } = await db
    .from("zoom_transcript_imports")
    .update({ document_id: documentId })
    .match({ business_id: businessId, meeting_uuid: meetingUuid })
    .select("id");
  if (error) {
    logger.warn("zoom transcript ledger: finalize failed", {
      businessId,
      error: error.message
    });
    return false;
  }
  // Zero matched rows (claim deleted/stolen mid-import) is NOT success:
  // the dedupe row is missing, which is exactly what callers escalate on.
  return ((data as { id: string }[] | null)?.length ?? 0) > 0;
}

/**
 * The ledger row behind a produced DOCUMENT, or null.
 *
 * Every other read here keys on (business, meeting UUID) because that is
 * what the import knows. The correction path starts from the other end: an
 * owner is looking at a document and says it was filed under the wrong
 * person, and the meeting key is what has to be recovered. Never throws; a
 * missing row means "not a Zoom import", which is a supported answer.
 */
export async function getZoomTranscriptImportByDocument(
  businessId: string,
  documentId: string,
  client?: SupabaseClient
): Promise<{ meeting_uuid: string; contact_id: string | null; outcome: string | null } | null> {
  const db = await ledgerClientOrNull(client, "document lookup");
  if (!db) return null;
  const { data, error } = await db
    .from("zoom_transcript_imports")
    .select("meeting_uuid,contact_id,outcome")
    .match({ business_id: businessId, document_id: documentId })
    .maybeSingle();
  if (error) {
    logger.warn("zoom transcript ledger: document lookup failed", {
      businessId,
      error: error.message
    });
    return null;
  }
  return (
    (data as {
      meeting_uuid: string;
      contact_id: string | null;
      outcome: string | null;
    } | null) ?? null
  );
}

/**
 * Hand a classified meeting back to be classified again, atomically.
 *
 * The classification stamp is deliberately permanent: it is what stops a
 * re-import writing a second note and a second set of to-dos. An owner
 * saying "this meeting was with somebody else" is the one event that
 * genuinely invalidates a past decision, so it clears the stamp, and the
 * normal claim/stamp cycle runs again on top.
 *
 * The clear is conditional on the stamp being SET so that it reports
 * honestly (false means "there was nothing to clear"), but the caller does
 * NOT gate on that: a null stamp means either "never classified" or "a pass
 * is running right now", and these columns cannot tell those apart.
 * `claimZoomTranscriptClassification` is the arbiter for both. Never
 * throws; a ledger blip answers false and the claim decides.
 */
export async function reopenZoomTranscriptClassification(
  businessId: string,
  meetingUuid: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = await ledgerClientOrNull(client, "classification reopen");
  if (!db) return false;
  const { data, error } = await db
    .from("zoom_transcript_imports")
    .update({ classified_at: null, outcome: null })
    .match({ business_id: businessId, meeting_uuid: meetingUuid })
    .not("classified_at", "is", null)
    .select("id");
  if (error) {
    logger.warn("zoom transcript ledger: classification reopen failed", {
      businessId,
      error: error.message
    });
    return false;
  }
  return ((data as { id: string }[] | null)?.length ?? 0) > 0;
}

/** A classification that has already been applied to this meeting. */
export type ZoomTranscriptClassification = {
  contactId: string | null;
  outcome: string | null;
  classifiedAt: string;
};

/**
 * The classification already applied to this meeting, or null for "not yet".
 *
 * The import ledger serializes the DOCUMENT, not the side effects, and
 * `reclaimCompletedZoomTranscriptImport` deliberately blanks `document_id`
 * so a manual re-import can produce a fresh one. Without this second stamp
 * that re-import would also write a second note and a second set of to-dos.
 * Re-importing a meeting re-files the document; it does not re-decide what
 * the meeting meant.
 *
 * Returning the stored decision rather than a bare boolean is what lets the
 * re-import re-link the NEW document to the SAME contact without paying for
 * a second classification or re-running attribution.
 *
 * Never throws: an unreadable ledger answers "not yet", and the caller's own
 * writes are individually guarded. The cost of being wrong here is a
 * duplicate note, not a lost one.
 */
export async function getZoomTranscriptClassification(
  businessId: string,
  meetingUuid: string,
  client?: SupabaseClient
): Promise<ZoomTranscriptClassification | null> {
  const db = await ledgerClientOrNull(client, "classification read");
  if (!db) return null;
  const { data, error } = await db
    .from("zoom_transcript_imports")
    .select("contact_id,outcome,classified_at")
    .match({ business_id: businessId, meeting_uuid: meetingUuid })
    .maybeSingle();
  if (error) {
    logger.warn("zoom transcript ledger: classification read failed", {
      businessId,
      error: error.message
    });
    return null;
  }
  const row = data as {
    contact_id: string | null;
    outcome: string | null;
    classified_at: string | null;
  } | null;
  if (!row?.classified_at) return null;
  return {
    contactId: row.contact_id,
    outcome: row.outcome,
    classifiedAt: row.classified_at
  };
}

/**
 * CLAIM the right to classify this meeting, atomically. True means this pass
 * owns it; false means another one already does (or already did).
 *
 * Claim-first, not check-then-act. Reading `classified_at` at the start and
 * stamping it at the end leaves the whole classify pass (two Gemini calls)
 * as a window in which a manual re-import, which
 * `reclaimCompletedZoomTranscriptImport` happily grants, schedules a SECOND
 * pass that also sees no stamp. Both then write a note and a set of to-dos,
 * which is precisely the duplicate the stamp exists to prevent (Bugbot,
 * PR #1566). The conditional update is the atomic arbiter, the same shape
 * `claimZoomTranscriptImport` uses one table over.
 *
 * The trade, taken deliberately: a pass that claims and then dies leaves the
 * meeting classified-but-empty forever, because there is no lease here. That
 * is the right direction for a best-effort enrichment. A meeting that never
 * gets a note is a missing nicety; a contact with two of everything is a mess
 * somebody has to clean up by hand.
 *
 * Never throws. A ledger blip answers false, so the pass declines to write
 * rather than risking a duplicate.
 */
export async function claimZoomTranscriptClassification(
  businessId: string,
  meetingUuid: string,
  client?: SupabaseClient,
  now: () => number = Date.now
): Promise<boolean> {
  const db = await ledgerClientOrNull(client, "classification claim");
  if (!db) return false;
  const { data, error } = await db
    .from("zoom_transcript_imports")
    .update({ classified_at: new Date(now()).toISOString() })
    .match({ business_id: businessId, meeting_uuid: meetingUuid })
    .is("classified_at", null)
    .select("id");
  if (error) {
    logger.warn("zoom transcript ledger: classification claim failed", {
      businessId,
      error: error.message
    });
    return false;
  }
  return ((data as { id: string }[] | null)?.length ?? 0) > 0;
}

/**
 * Record WHAT the classification decided, onto a row this pass already
 * claimed.
 *
 * Deliberately does not touch `classified_at`: the claim owns that column,
 * and it means "a pass has taken this meeting", not "a pass finished". The
 * two are distinguishable by `outcome`, which stays null for a pass that
 * claimed and then died.
 *
 * Stamped even when the classification wrote nothing to a record (an unclear
 * outcome, no contact match): the fact being stored is what was decided,
 * which is exactly what must not be decided twice. Never throws.
 */
export async function stampZoomTranscriptClassification(
  businessId: string,
  meetingUuid: string,
  result: { contactId: string | null; outcome: string },
  client?: SupabaseClient
): Promise<void> {
  const db = await ledgerClientOrNull(client, "classification stamp");
  if (!db) return;
  const { error } = await db
    .from("zoom_transcript_imports")
    .update({ contact_id: result.contactId, outcome: result.outcome })
    .match({ business_id: businessId, meeting_uuid: meetingUuid });
  if (error) {
    logger.warn("zoom transcript ledger: classification stamp failed", {
      businessId,
      error: error.message
    });
  }
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
