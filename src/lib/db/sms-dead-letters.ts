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

type InboundJobPayload = {
  data?: { payload?: { text?: string; from?: { phone_number?: string } } };
};

/** Pull the sender and text out of the stored Telnyx envelope. */
function readEnvelope(payload: unknown): { from: string; preview: string } {
  const inner = ((payload ?? {}) as InboundJobPayload).data?.payload ?? {};
  const from = typeof inner.from?.phone_number === "string" ? inner.from.phone_number : "";
  const text = typeof inner.text === "string" ? inner.text : "";
  return { from, preview: text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS) };
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
  const limit = options?.limit ?? 25;
  let q = db
    .from("sms_inbound_jobs")
    .select("id, business_id, created_at, attempt_count, last_error, payload")
    .eq("status", "dead_letter")
    .is("deleted_at", null);
  if (options?.businessId) q = q.eq("business_id", options.businessId);
  if (options?.sinceDays && options.sinceDays > 0) {
    q = q.gte(
      "created_at",
      new Date(Date.now() - options.sinceDays * 24 * 60 * 60 * 1000).toISOString()
    );
  }
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

/** Group rows by tenant, most affected first. Pure. */
export function countByBusiness(rows: readonly InboundDeadLetterRow[]): InboundDeadLetterCount[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.businessId, (counts.get(r.businessId) ?? 0) + 1);
  return [...counts]
    .map(([businessId, count]) => ({ businessId, count }))
    .sort((a, b) => b.count - a.count || a.businessId.localeCompare(b.businessId));
}
