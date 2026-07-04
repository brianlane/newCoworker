/**
 * Call-summary sweep (Standard/Enterprise perk, tier relaunch).
 *
 * Every 5 minutes (see 20260727000001_schedule_call_summary_sweep.sql) this
 * scans recently completed, unsummarized voice transcripts, filters to
 * entitled tenants, and dispatches each to the Next.js
 * `/api/internal/summarize-call` endpoint — the Gemini call and AI-budget
 * metering live there (Next.js runtime), this Edge layer is just cheap
 * scan-and-dispatch, mirroring `customer-memory-summarize-sweep`.
 *
 * Eligibility (all enforced in the scan query):
 *   - status 'completed' with a non-null ended_at
 *   - summarized_at IS NULL (success or terminal skip sets it)
 *   - summary_attempts < CALL_SUMMARY_MAX_ATTEMPTS (poisoned rows stop
 *     retrying; the partial index keeps this scan cheap)
 *   - ended within CALL_SUMMARY_WINDOW_HOURS (an upgrade never triggers a
 *     mass backfill of months-old calls)
 *
 * Tier filtering happens here too (not only in the endpoint) so Starter
 * tenants' calls don't burn dispatch slots every sweep. Sequential dispatch,
 * per-business cap, errors counted but never re-thrown — one tenant's bad row
 * must never wedge the batch.
 *
 * Dependency-injected (structural supabase type + fetchFn) so this is
 * unit-tested from vitest under the shared 100% coverage gate, mirroring
 * scheduled_sms.ts / missed_call_autotext.ts.
 */

type Rows = { data: unknown; error: { message: string } | null };

export interface CallSummarySweepSupabase {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string
      ): {
        is(
          column: string,
          value: null
        ): {
          lt(
            column: string,
            value: number
          ): {
            gte(
              column: string,
              value: string
            ): {
              order(
                column: string,
                opts: { ascending: boolean }
              ): { limit(n: number): PromiseLike<Rows> };
            };
          };
        };
      };
      in(column: string, values: string[]): PromiseLike<Rows>;
    };
  };
}

/** Stop retrying a row after this many failed attempts. */
export const CALL_SUMMARY_MAX_ATTEMPTS = 3;

/** Only calls that ended within this window are eligible (no mass backfill). */
export const CALL_SUMMARY_WINDOW_HOURS = 48;

/** Hard cap on dispatches per sweep run. */
export const CALL_SUMMARY_BATCH_LIMIT = 20;

/** Per-business cap so one busy tenant can't monopolize the batch. */
export const CALL_SUMMARY_BATCH_PER_BUSINESS = 5;

/** Tiers entitled to AI call summaries. */
export function callSummarySweepTierAllowed(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}

type CandidateRow = { id: string; business_id: string };

export type CallSummarySweepResult = {
  scanned: number;
  dispatched: number;
  succeeded: number;
  failed: number;
  failures: Array<{ transcriptId: string; reason: string }>;
};

export async function processCallSummarySweep(
  supabase: CallSummarySweepSupabase,
  opts: {
    /** Next.js origin, e.g. https://app.example.com (no trailing slash needed). */
    platformBaseUrl: string;
    /** INTERNAL_CRON_SECRET bearer forwarded to the summarize endpoint. */
    platformBearer: string;
    batchLimit?: number;
    fetchFn?: typeof fetch;
    nowMs?: number;
  }
): Promise<CallSummarySweepResult> {
  const batchLimit = opts.batchLimit ?? CALL_SUMMARY_BATCH_LIMIT;
  const cutoffIso = new Date(
    (opts.nowMs ?? Date.now()) - CALL_SUMMARY_WINDOW_HOURS * 3_600_000
  ).toISOString();

  // Newest-first inside the window: fresh calls are what the owner is looking
  // at right now. Wide net (batch × 4) so tier filtering + the per-business
  // cap still leave a full batch when a Starter tenant dominates the window.
  const { data: rowsRaw, error: scanErr } = await supabase
    .from("voice_call_transcripts")
    .select("id, business_id")
    .eq("status", "completed")
    .is("summarized_at", null)
    .lt("summary_attempts", CALL_SUMMARY_MAX_ATTEMPTS)
    .gte("ended_at", cutoffIso)
    .order("ended_at", { ascending: false })
    .limit(batchLimit * 4);
  if (scanErr) throw new Error(`call_summary_scan: ${scanErr.message}`);
  const candidates = (Array.isArray(rowsRaw) ? rowsRaw : []) as CandidateRow[];

  if (candidates.length === 0) {
    return { scanned: 0, dispatched: 0, succeeded: 0, failed: 0, failures: [] };
  }

  const businessIds = [...new Set(candidates.map((r) => r.business_id))];
  const { data: bizRaw, error: bizErr } = await supabase
    .from("businesses")
    .select("id, tier")
    .in("id", businessIds);
  if (bizErr) throw new Error(`call_summary_tiers: ${bizErr.message}`);
  const tierById = new Map(
    ((Array.isArray(bizRaw) ? bizRaw : []) as Array<{ id: string; tier: string | null }>).map(
      (b) => [b.id, b.tier]
    )
  );

  const perBiz = new Map<string, number>();
  const eligible: CandidateRow[] = [];
  for (const row of candidates) {
    if (!callSummarySweepTierAllowed(tierById.get(row.business_id))) continue;
    const seen = perBiz.get(row.business_id) ?? 0;
    if (seen >= CALL_SUMMARY_BATCH_PER_BUSINESS) continue;
    perBiz.set(row.business_id, seen + 1);
    eligible.push(row);
    if (eligible.length >= batchLimit) break;
  }

  const doFetch = opts.fetchFn ?? fetch;
  const endpoint = `${opts.platformBaseUrl.replace(/\/$/, "")}/api/internal/summarize-call`;
  let succeeded = 0;
  let failed = 0;
  const failures: Array<{ transcriptId: string; reason: string }> = [];

  // Sequential — one Gemini flash call each; parallelizing would just burst
  // the platform endpoint for no user-visible latency win.
  for (const row of eligible) {
    try {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.platformBearer}`
        },
        body: JSON.stringify({
          businessId: row.business_id,
          transcriptId: row.id,
          source: "cron_sweep"
        })
      });
      if (res.ok) {
        succeeded += 1;
      } else {
        failed += 1;
        const text = await res.text().catch(() => "");
        failures.push({ transcriptId: row.id, reason: `http_${res.status}: ${text.slice(0, 120)}` });
      }
    } catch (err) {
      failed += 1;
      failures.push({
        transcriptId: row.id,
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return {
    scanned: candidates.length,
    dispatched: eligible.length,
    succeeded,
    failed,
    failures: failures.slice(0, 10)
  };
}
