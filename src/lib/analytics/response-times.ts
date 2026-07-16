/**
 * Customer response-time report — how fast inbound texts get answered.
 *
 * Derived from `sms_inbound_jobs` (central engine table): a job's
 * `created_at` is the inbound receipt and `updated_at` is stamped when the
 * reply completes (`complete_sms_inbound_job*`), so `updated_at −
 * created_at` is the customer-observed wait for `done` jobs. Retried jobs
 * carry their LAST completion stamp — the honest number, since that is
 * when the customer actually got the reply.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Trailing window, matching the rest of the analytics page. */
export const RESPONSE_TIME_WINDOW_DAYS = 30;
/** Jobs scanned per report; beyond it the report flags `clipped`. */
export const RESPONSE_TIME_SCAN_LIMIT = 5000;

export type ResponseTimeStats = {
  /** Replied (status=done) inbound texts in the window. */
  repliedCount: number;
  medianSeconds: number | null;
  averageSeconds: number | null;
  p90Seconds: number | null;
  /** Share of replies delivered within 60 seconds (0-1). */
  underMinuteShare: number | null;
  /** Inbound texts that dead-lettered (never got a reply). */
  deadLetterCount: number;
  clipped: boolean;
};

/** Percentile over a sorted ascending array (nearest-rank). */
function percentile(sortedAsc: number[], p: number): number {
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

export async function getResponseTimeStats(
  businessId: string,
  opts: { client?: SupabaseClient; now?: Date } = {}
): Promise<ResponseTimeStats> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const startIso = new Date(
    now.getTime() - RESPONSE_TIME_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await db
    .from("sms_inbound_jobs")
    .select("status, created_at, updated_at")
    .eq("business_id", businessId)
    .gte("created_at", startIso)
    .in("status", ["done", "dead_letter"])
    .order("created_at", { ascending: false })
    .limit(RESPONSE_TIME_SCAN_LIMIT);
  if (error) throw new Error(`getResponseTimeStats: ${error.message}`);

  type Row = { status: string; created_at: string; updated_at: string };
  const rows = ((data as Row[] | null) ?? []);

  const waits: number[] = [];
  let deadLetterCount = 0;
  for (const row of rows) {
    if (row.status === "dead_letter") {
      deadLetterCount += 1;
      continue;
    }
    const created = Date.parse(row.created_at);
    const updated = Date.parse(row.updated_at);
    /* c8 ignore next -- DB timestamptz columns are always parseable */
    if (!Number.isFinite(created) || !Number.isFinite(updated)) continue;
    waits.push(Math.max(0, (updated - created) / 1000));
  }
  waits.sort((a, b) => a - b);

  if (waits.length === 0) {
    return {
      repliedCount: 0,
      medianSeconds: null,
      averageSeconds: null,
      p90Seconds: null,
      underMinuteShare: null,
      deadLetterCount,
      clipped: rows.length >= RESPONSE_TIME_SCAN_LIMIT
    };
  }

  const sum = waits.reduce((s, v) => s + v, 0);
  const underMinute = waits.filter((v) => v <= 60).length;
  return {
    repliedCount: waits.length,
    medianSeconds: Math.round(percentile(waits, 50)),
    averageSeconds: Math.round(sum / waits.length),
    p90Seconds: Math.round(percentile(waits, 90)),
    underMinuteShare: Math.round((underMinute / waits.length) * 100) / 100,
    deadLetterCount,
    clipped: rows.length >= RESPONSE_TIME_SCAN_LIMIT
  };
}
