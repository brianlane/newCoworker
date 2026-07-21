/**
 * Meta Conversion Leads outbox drain.
 *
 * Called per-minute (pg_cron → Edge `meta-capi-drain` → the internal
 * route): claims a bounded batch of pending `meta_capi_events` rows,
 * resolves each lead's Meta identifiers (the newest `lead_submissions` row
 * carrying a leadgen_id for the contact's numbers/email), and uploads the
 * stage event to the connection's dataset. Terminal states:
 *   - sent:    Meta accepted the event;
 *   - skipped: the lead isn't a Meta lead (no submission with identifiers)
 *              — a non-event, not an error;
 *   - expired: older than Meta's 7-day acceptance window;
 *   - failed:  exhausted upload retries.
 * Everything transient stays `pending` and retries next tick until it
 * expires: upload errors bump `attempts` (capped), and a not-CAPI-ready
 * connection (missing, paused, mid-reconnect, lookup failure) just waits —
 * a tenant who re-enables the connection within the window loses nothing.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getMetaConnection, type MetaConnectionRow } from "@/lib/db/meta-connections";
import {
  CAPI_EVENT_MAX_AGE_MS,
  buildConversionLeadBody,
  sendConversionLeadBody
} from "@/lib/meta/capi";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Rows per tick — small enough for a route invocation, large enough to keep up. */
export const CAPI_DRAIN_BATCH = 50;
/** Upload attempts before a row is marked failed (it expires at 7d anyway). */
export const CAPI_MAX_ATTEMPTS = 10;
/**
 * An in-flight `sending` claim older than this is presumed crashed and
 * reclaimed. Well past the route's maxDuration, so a live drain can never
 * have its rows stolen mid-upload.
 */
export const CAPI_CLAIM_STALE_MS = 10 * 60 * 1000;

type OutboxRow = {
  id: string;
  business_id: string;
  contact_e164: string;
  event_name: string;
  event_time: string;
  dedupe_key: string;
  attempts: number;
};

export type CapiDrainSummary = {
  claimed: number;
  sent: number;
  skipped: number;
  expired: number;
  failed: number;
  /** Transient errors left pending for the next tick. */
  deferred: number;
};

async function markRow(
  db: SupabaseClient,
  id: string,
  fields: Record<string, unknown>
): Promise<void> {
  const { error } = await db.from("meta_capi_events").update(fields).eq("id", id);
  if (error) {
    logger.warn("meta capi drain: row update failed", { id, error: error.message });
  }
}

/**
 * The lead's newest Meta-identified submission: primary+alias phones
 * first, contact email as the fallback join. Null when the lead has no
 * submission carrying a leadgen_id — i.e. not a Meta Lead Ads lead.
 */
async function findMetaSubmission(
  db: SupabaseClient,
  businessId: string,
  contactE164: string
): Promise<{ leadgen_id: string; email: string | null } | null> {
  // Contact row for merge aliases + email (best-effort — the contact may
  // have been deleted since enqueue; phones alone still resolve).
  let aliases: string[] = [];
  let contactEmail: string | null = null;
  const { data: contact } = await db
    .from("contacts")
    .select("alias_e164s, email")
    .eq("business_id", businessId)
    .eq("customer_e164", contactE164)
    .maybeSingle();
  if (contact) {
    aliases = (contact as { alias_e164s: string[] | null }).alias_e164s ?? [];
    contactEmail = (contact as { email: string | null }).email ?? null;
  }

  const { data: byPhone, error: phoneErr } = await db
    .from("lead_submissions")
    .select("leadgen_id, email")
    .eq("business_id", businessId)
    .in("phone_e164", [contactE164, ...aliases])
    .not("leadgen_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (phoneErr) throw new Error(`capi drain: submission by phone: ${phoneErr.message}`);
  if (byPhone) return byPhone as { leadgen_id: string; email: string | null };

  const email = contactEmail?.trim().toLowerCase();
  if (!email) return null;
  const { data: byEmail, error: emailErr } = await db
    .from("lead_submissions")
    .select("leadgen_id, email")
    .eq("business_id", businessId)
    .eq("email", email)
    .not("leadgen_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (emailErr) throw new Error(`capi drain: submission by email: ${emailErr.message}`);
  return (byEmail as { leadgen_id: string; email: string | null } | null) ?? null;
}

/** Drain one batch. Never throws; per-row failures are recorded on the row. */
export async function drainMetaCapiEvents(
  client?: SupabaseClient
): Promise<CapiDrainSummary> {
  const db = client ?? (await createSupabaseServiceClient());
  const summary: CapiDrainSummary = {
    claimed: 0,
    sent: 0,
    skipped: 0,
    expired: 0,
    failed: 0,
    deferred: 0
  };

  // Reclaim stale in-flight claims from a crashed drain (best-effort).
  {
    const { error: reclaimErr } = await db
      .from("meta_capi_events")
      .update({ status: "pending", claimed_at: null })
      .eq("status", "sending")
      .lt("claimed_at", new Date(Date.now() - CAPI_CLAIM_STALE_MS).toISOString());
    if (reclaimErr) {
      logger.warn("meta capi drain: stale-claim reclaim failed", {
        error: reclaimErr.message
      });
    }
  }

  const { data, error } = await db
    .from("meta_capi_events")
    .select("id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(CAPI_DRAIN_BATCH);
  if (error) {
    logger.warn("meta capi drain: batch read failed", { error: error.message });
    return summary;
  }
  const candidateIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (candidateIds.length === 0) return summary;

  // Atomic claim: only rows still `pending` flip to `sending`, so
  // overlapping drain invocations (long tick, manual replay) can never
  // upload the same row twice — each processes only the rows it won.
  const { data: claimedData, error: claimErr } = await db
    .from("meta_capi_events")
    .update({ status: "sending", claimed_at: new Date().toISOString() })
    .eq("status", "pending")
    .in("id", candidateIds)
    .select("id, business_id, contact_e164, event_name, event_time, dedupe_key, attempts");
  if (claimErr) {
    logger.warn("meta capi drain: claim failed", { error: claimErr.message });
    return summary;
  }
  const rows = (claimedData ?? []) as OutboxRow[];
  summary.claimed = rows.length;
  if (rows.length === 0) return summary;

  // One connection lookup per business in the batch.
  const connections = new Map<string, MetaConnectionRow | null>();
  for (const businessId of new Set(rows.map((r) => r.business_id))) {
    connections.set(
      businessId,
      await getMetaConnection(businessId, db).catch((err) => {
        logger.warn("meta capi drain: connection lookup failed", {
          businessId,
          error: err instanceof Error ? err.message : String(err)
        });
        return null;
      })
    );
  }

  for (const row of rows) {
    const eventTimeMs = Date.parse(row.event_time);
    if (Number.isFinite(eventTimeMs) && Date.now() - eventTimeMs > CAPI_EVENT_MAX_AGE_MS) {
      await markRow(db, row.id, { status: "expired", claimed_at: null });
      summary.expired += 1;
      continue;
    }

    // The map was populated for every business in the batch above.
    const connection = connections.get(row.business_id) as MetaConnectionRow | null;
    if (
      !connection ||
      !connection.dataset_id ||
      !connection.capi_enabled ||
      !connection.is_active ||
      connection.status !== "active" ||
      !connection.pageToken
    ) {
      // Often temporary (paused connection, mid-reconnect, lookup error):
      // release the claim back to pending — it retries every tick until
      // the connection comes back or the 7-day window expires it. attempts
      // is reserved for real upload tries, so waiting never burns the cap.
      await markRow(db, row.id, {
        status: "pending",
        claimed_at: null,
        last_error: "no capi-ready meta connection"
      });
      summary.deferred += 1;
      continue;
    }

    let submission: { leadgen_id: string; email: string | null } | null = null;
    let body: string | null = null;
    try {
      submission = await findMetaSubmission(db, row.business_id, row.contact_e164);
      if (submission) {
        body = buildConversionLeadBody({
          eventName: row.event_name,
          eventTimeMs: Number.isFinite(eventTimeMs) ? eventTimeMs : Date.now(),
          eventId: row.dedupe_key,
          leadgenId: submission.leadgen_id,
          email: submission.email,
          phoneE164: row.contact_e164
        });
      }
    } catch (err) {
      // Resolution is a DB read — treat as transient and retry next tick.
      await markRow(db, row.id, {
        status: "pending",
        claimed_at: null,
        attempts: row.attempts + 1,
        last_error: err instanceof Error ? err.message : String(err)
      });
      summary.deferred += 1;
      continue;
    }
    if (!submission || !body) {
      await markRow(db, row.id, {
        status: "skipped",
        claimed_at: null,
        last_error: "no meta lead identifiers for this contact"
      });
      summary.skipped += 1;
      continue;
    }

    try {
      await sendConversionLeadBody(connection.dataset_id, connection.pageToken, body);
      // If THIS update fails, the row stays `sending` and is retried only
      // after the stale-claim window — and the re-upload carries the same
      // event_id (the dedupe key), which Meta deduplicates server-side, so
      // a lost bookkeeping write can never double-count a conversion.
      await markRow(db, row.id, {
        status: "sent",
        claimed_at: null,
        sent_at: new Date().toISOString(),
        last_error: null
      });
      summary.sent += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      if (attempts >= CAPI_MAX_ATTEMPTS) {
        await markRow(db, row.id, {
          status: "failed",
          claimed_at: null,
          attempts,
          last_error: message
        });
        summary.failed += 1;
      } else {
        await markRow(db, row.id, {
          status: "pending",
          claimed_at: null,
          attempts,
          last_error: message
        });
        summary.deferred += 1;
      }
    }
  }

  if (summary.sent > 0 || summary.failed > 0) {
    logger.info("meta capi drain: summary", { ...summary });
  }
  return summary;
}
