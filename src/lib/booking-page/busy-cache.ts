/**
 * Last-known-good provider busy cache (stale-while-error).
 *
 * The booking page degrades to business hours minus the ledger when a
 * provider's free/busy is unreadable, which re-opens provider-only events
 * to double-booking. This cache closes most of that window: every
 * successful fetch persists its spans, and a FAILED fetch serves the most
 * recent snapshot while it is fresh (bounded staleness), so a time the
 * provider reported busy stays blocked through the outage. Honest limits:
 * events created DURING the outage are invisible (irreducible without
 * data), and a stale span can block a time that has since freed up, which
 * is the safe direction to err.
 *
 * Both operations are best-effort and never throw: the cache is an
 * availability aid, and a cache hiccup must degrade exactly like a cache
 * miss.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { BusyBlock } from "@/lib/booking-page/slots";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Snapshots older than this never serve; callers fall back to the baseline. */
export const BUSY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type StoredSpan = { start: string; end: string };

/** Persist a successful fetch's spans. Best-effort write-through. */
export async function saveBusyCache(
  businessId: string,
  windowStart: Date,
  windowEnd: Date,
  busy: BusyBlock[],
  client?: SupabaseClient
): Promise<void> {
  const spans: StoredSpan[] = [];
  for (const b of busy) {
    spans.push({ start: b.start.toISOString(), end: b.end.toISOString() });
  }
  const row = {
    business_id: businessId,
    busy: spans,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    fetched_at: new Date().toISOString()
  };
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { error } = await db
      .from("booking_busy_cache")
      .upsert(row, { onConflict: "business_id" });
    if (error) throw new Error(error.message);
  } catch (err) {
    logger.warn("busy-cache: save failed (cache skipped)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * The last snapshot's spans when fresh enough, else null. Malformed rows
 * and read errors read as a miss.
 */
export async function readBusyCache(
  businessId: string,
  maxAgeMs = BUSY_CACHE_MAX_AGE_MS,
  client?: SupabaseClient
): Promise<BusyBlock[] | null> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("booking_busy_cache")
      .select("busy, fetched_at")
      .eq("business_id", businessId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;

    const fetchedAt = Date.parse((data as { fetched_at: string }).fetched_at);
    if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > maxAgeMs) return null;

    const raw = (data as { busy: unknown }).busy;
    if (!Array.isArray(raw)) return null;
    const blocks: BusyBlock[] = [];
    for (const span of raw) {
      const start = new Date((span as StoredSpan)?.start ?? "");
      const end = new Date((span as StoredSpan)?.end ?? "");
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
      blocks.push({ start, end });
    }
    return blocks;
  } catch (err) {
    logger.warn("busy-cache: read failed (treated as miss)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
