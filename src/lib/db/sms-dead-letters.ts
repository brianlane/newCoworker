/**
 * Inbound texts the platform could not process, fleet-wide.
 *
 * These had no admin surface at all, which is how 109 of them accumulated over
 * two months without anyone noticing either way. They were benign (short-code
 * blasts that are unreplyable by design and whose flows had already run), but
 * the point stands: if a REAL inbound failure had happened for any tenant, there
 * was nowhere it would have shown up.
 *
 * `sms-inbound-worker` now completes the benign case normally, so anything left
 * in `dead_letter` is worth looking at.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { customerE164FromPayload, inboundTextFromPayload } from "@/lib/db/sms-history";
import type { SupabaseClient } from "@supabase/supabase-js";

export type InboundDeadLetterRow = {
  id: string;
  businessId: string;
  createdAt: string;
  attemptCount: number;
  /** The worker's reason string, e.g. "missing_from_or_text". */
  error: string;
  /**
   * Sender as it arrived. Shown VERBATIM when it is not a recognizable phone or
   * short code, because an unusable origin is exactly what these rows are about
   * and "(no sender)" would hide the evidence.
   */
  from: string;
  /** First part of the message, for recognizing what was lost. */
  preview: string;
};

/** Exact per-tenant tally from the database, never a sampled estimate. */
export type InboundDeadLetterCount = { businessId: string; count: number };

const PREVIEW_CHARS = 160;
/** Enough to identify a bad origin without letting junk dominate the row. */
const SENDER_CHARS = 40;

/** Start of the lookback window as an ISO timestamp. */
function windowStart(sinceDays: number): string {
  return new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The sender exactly as stored, whatever shape it took, with no validity filter.
 * `customerE164FromPayload` deliberately rejects anything that is not a phone or
 * a short code, which is right for a conversation index and wrong here: a
 * dead-letter caused by an alphanumeric or garbage origin has to show that
 * origin.
 */
function rawSenderFromPayload(payload: unknown): string {
  const inner = ((payload ?? {}) as { data?: { payload?: Record<string, unknown> } }).data?.payload;
  if (!inner) return "";
  const from = inner["from"];
  if (typeof from === "string") return from.trim().slice(0, SENDER_CHARS);
  if (from && typeof from === "object" && !Array.isArray(from)) {
    const phone = (from as { phone_number?: unknown }).phone_number;
    if (typeof phone === "string") return phone.trim().slice(0, SENDER_CHARS);
  }
  return "";
}

/**
 * Pull the sender and text out of the stored Telnyx envelope, reusing the Text
 * history parsers rather than a second implementation. Telnyx is inconsistent
 * about all of it: `from` is sometimes a string and sometimes an object, the body
 * is `text` or `body` or a nested RCS object, and a sender can be a short code
 * rather than E.164. Those helpers already handle every one of those shapes; the
 * raw fallback covers the origins they (correctly) refuse.
 */
function readEnvelope(payload: unknown): { from: string; preview: string } {
  const row = (payload ?? null) as Record<string, unknown> | null;
  return {
    from: customerE164FromPayload(row) ?? rawSenderFromPayload(payload),
    preview: inboundTextFromPayload(row).replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS)
  };
}

/**
 * Dead-lettered inbound texts, newest first. Omit `businessId` for the whole
 * fleet (the admin view) or pass one to scope to a client.
 */
export async function listInboundDeadLetters(
  options?: {
    businessId?: string;
    sinceDays?: number;
    limit?: number;
  },
  client?: SupabaseClient
): Promise<InboundDeadLetterRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { businessId, sinceDays, limit = 25 } = options ?? {};
  let q = db
    .from("sms_inbound_jobs")
    .select("id, business_id, created_at, attempt_count, last_error, payload")
    .eq("status", "dead_letter")
    .is("deleted_at", null);
  if (businessId) q = q.eq("business_id", businessId);
  if (sinceDays && sinceDays > 0) q = q.gte("created_at", windowStart(sinceDays));
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
  // Never break the admin page over this: an empty list reads as "nothing
  // wrong", and the page has plenty of other signal.
  if (error) {
    console.error("listInboundDeadLetters", error.message);
    return [];
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const { from, preview } = readEnvelope(r.payload);
    return {
      id: String(r.id),
      businessId: String(r.business_id),
      createdAt: String(r.created_at),
      attemptCount: Number(r.attempt_count ?? 0),
      error: String(r.last_error ?? "unknown"),
      from,
      preview
    };
  });
}

export type InboundDeadLetterSummary = {
  /** Exact count for the window, NOT the length of any displayed sample. */
  total: number;
  /** Exact per-tenant counts, most affected first. */
  byBusiness: InboundDeadLetterCount[];
};

/**
 * Exact totals for the window, from a grouped count in SQL
 * (`inbound_dead_letter_counts`). Separate from `listInboundDeadLetters` because
 * the card shows a short sample of rows but must report the real scale: a count
 * taken from that sample would tell an admin there were 20 failures when there
 * were 300, and would drop any tenant the noisiest one crowded out.
 */
export async function summarizeInboundDeadLetters(
  options?: { sinceDays?: number },
  client?: SupabaseClient
): Promise<InboundDeadLetterSummary> {
  const db = client ?? (await createSupabaseServiceClient());
  const sinceDays = options?.sinceDays;
  const { data, error } = await db.rpc("inbound_dead_letter_counts", {
    p_since: sinceDays && sinceDays > 0 ? windowStart(sinceDays) : null
  });
  if (error) {
    console.error("summarizeInboundDeadLetters", error.message);
    return { total: 0, byBusiness: [] };
  }
  const byBusiness = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    businessId: String(r.business_id),
    count: Number(r.failure_count ?? 0)
  }));
  return {
    total: byBusiness.reduce((sum, b) => sum + b.count, 0),
    byBusiness
  };
}
