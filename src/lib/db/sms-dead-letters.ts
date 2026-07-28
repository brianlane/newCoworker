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
  /** Sender as it arrived (may be a short code, so not necessarily E.164). */
  from: string;
  /** First part of the message, for recognizing what was lost. */
  preview: string;
};

/** Per-tenant tally, so one noisy tenant is obvious at a glance. */
export type InboundDeadLetterCount = { businessId: string; count: number };

const PREVIEW_CHARS = 160;

/** Start of the lookback window as an ISO timestamp. */
function windowStart(sinceDays: number): string {
  return new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Pull the sender and text out of the stored Telnyx envelope, reusing the Text
 * history parsers rather than a second implementation. Telnyx is inconsistent
 * about all of it: `from` is sometimes a string and sometimes an object, the body
 * is `text` or `body` or a nested RCS object, and a sender can be a short code
 * rather than E.164. Those helpers already handle every one of those shapes.
 */
function readEnvelope(payload: unknown): { from: string; preview: string } {
  const row = (payload ?? null) as Record<string, unknown> | null;
  return {
    from: customerE164FromPayload(row) ?? "",
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

/** Group ids by tenant, most affected first. Pure. */
export function countByBusiness(
  businessIds: readonly string[]
): InboundDeadLetterCount[] {
  const counts = new Map<string, number>();
  for (const id of businessIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts]
    .map(([businessId, count]) => ({ businessId, count }))
    .sort((a, b) => b.count - a.count || a.businessId.localeCompare(b.businessId));
}

/**
 * How many rows the tallies are allowed to scan. The TOTAL is an exact count
 * from the database regardless; this only bounds the per-tenant breakdown.
 */
export const TALLY_SCAN_LIMIT = 500;

export type InboundDeadLetterSummary = {
  /** Exact count for the window, NOT the length of any displayed sample. */
  total: number;
  /** True when more rows exist than the tallies scanned, so they are a floor. */
  capped: boolean;
  byBusiness: InboundDeadLetterCount[];
};

/**
 * Totals for the window. Separate from `listInboundDeadLetters` because the card
 * shows a short sample of rows but must report the real scale: deriving the count
 * from a 20-row sample would tell an admin there were 20 failures when there were
 * 300.
 */
export async function summarizeInboundDeadLetters(
  options?: { businessId?: string; sinceDays?: number },
  client?: SupabaseClient
): Promise<InboundDeadLetterSummary> {
  const db = client ?? (await createSupabaseServiceClient());
  const { businessId, sinceDays } = options ?? {};
  let q = db
    .from("sms_inbound_jobs")
    .select("business_id", { count: "exact" })
    .eq("status", "dead_letter")
    .is("deleted_at", null);
  if (businessId) q = q.eq("business_id", businessId);
  if (sinceDays && sinceDays > 0) q = q.gte("created_at", windowStart(sinceDays));
  const { data, error, count } = await q
    .order("created_at", { ascending: false })
    .limit(TALLY_SCAN_LIMIT);
  if (error) {
    console.error("summarizeInboundDeadLetters", error.message);
    return { total: 0, capped: false, byBusiness: [] };
  }
  const ids = ((data ?? []) as Array<{ business_id?: unknown }>).map((r) => String(r.business_id));
  const total = typeof count === "number" ? count : ids.length;
  return { total, capped: total > ids.length, byBusiness: countByBusiness(ids) };
}
