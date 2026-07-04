/**
 * Call-summary sweep (Standard/Enterprise perk, tier relaunch).
 *
 * Every 5 minutes (see 20260727000001_schedule_call_summary_sweep.sql) this
 * scans recently completed, unsummarized voice transcripts for entitled
 * tenants and dispatches each to the Next.js `/api/internal/summarize-call`
 * endpoint — the Gemini call and AI-budget metering live there (Next.js
 * runtime), this Edge layer is just cheap scan-and-dispatch, mirroring
 * `customer-memory-summarize-sweep`.
 *
 * Eligibility (ALL enforced in the scan query — including tier, via an inner
 * join on businesses, so a stream of Starter calls can never crowd entitled
 * rows out of the scan slice):
 *   - status 'completed' with a non-null ended_at
 *   - summarized_at IS NULL (success or terminal skip sets it)
 *   - summary_attempts < CALL_SUMMARY_MAX_ATTEMPTS (poisoned rows stop
 *     retrying; the partial index keeps this scan cheap)
 *   - businesses.tier in CALL_SUMMARY_TIERS
 *   - ended within CALL_SUMMARY_WINDOW_HOURS (an upgrade never triggers a
 *     mass backfill of months-old calls)
 *
 * Sequential dispatch under a wall-clock budget (CALL_SUMMARY_TIME_BUDGET_MS)
 * so the run always finishes inside the pg_net cron timeout — anything left
 * over is reported as `deferred` and picked up by the next 5-minute pass.
 * Per-business cap, errors counted but never re-thrown — one tenant's bad row
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
              in(
                column: string,
                values: string[]
              ): {
                order(
                  column: string,
                  opts: { ascending: boolean }
                ): { limit(n: number): PromiseLike<Rows> };
              };
            };
          };
        };
      };
    };
  };
}

/** Tiers entitled to AI call summaries (re-checked at generation time too). */
export const CALL_SUMMARY_TIERS = ["standard", "enterprise"];

/** Stop retrying a row after this many attempts. */
export const CALL_SUMMARY_MAX_ATTEMPTS = 3;

/** Only calls that ended within this window are eligible (no mass backfill). */
export const CALL_SUMMARY_WINDOW_HOURS = 48;

/** Hard cap on dispatches per sweep run. */
export const CALL_SUMMARY_BATCH_LIMIT = 20;

/** Per-business cap so one busy tenant can't monopolize the batch. */
export const CALL_SUMMARY_BATCH_PER_BUSINESS = 5;

/**
 * Wall-clock budget for the dispatch loop. The pg_net cron waits 120s; one
 * in-flight dispatch can hold up to the endpoint's 30s maxDuration past the
 * budget, so 85s keeps the worst case (~115s) inside the timeout with margin.
 */
export const CALL_SUMMARY_TIME_BUDGET_MS = 85_000;

type CandidateRow = { id: string; business_id: string };

export type CallSummarySweepResult = {
  scanned: number;
  dispatched: number;
  succeeded: number;
  failed: number;
  /** Eligible rows left for the next pass (budget exhausted). */
  deferred: number;
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
    timeBudgetMs?: number;
    fetchFn?: typeof fetch;
    nowMs?: number;
  }
): Promise<CallSummarySweepResult> {
  const batchLimit = opts.batchLimit ?? CALL_SUMMARY_BATCH_LIMIT;
  const timeBudgetMs = opts.timeBudgetMs ?? CALL_SUMMARY_TIME_BUDGET_MS;
  const startedAtMs = opts.nowMs ?? Date.now();
  const cutoffIso = new Date(startedAtMs - CALL_SUMMARY_WINDOW_HOURS * 3_600_000).toISOString();

  // Newest-first inside the window: fresh calls are what the owner is looking
  // at right now. Tier is filtered here in SQL (inner join), so the slice is
  // all-entitled; the ×2 net only absorbs per-business-cap drops.
  const { data: rowsRaw, error: scanErr } = await supabase
    .from("voice_call_transcripts")
    .select("id, business_id, businesses!inner(tier)")
    .eq("status", "completed")
    .is("summarized_at", null)
    .lt("summary_attempts", CALL_SUMMARY_MAX_ATTEMPTS)
    .gte("ended_at", cutoffIso)
    .in("businesses.tier", [...CALL_SUMMARY_TIERS])
    .order("ended_at", { ascending: false })
    .limit(batchLimit * 2);
  if (scanErr) throw new Error(`call_summary_scan: ${scanErr.message}`);
  const candidates = (Array.isArray(rowsRaw) ? rowsRaw : []) as CandidateRow[];

  const perBiz = new Map<string, number>();
  const eligible: CandidateRow[] = [];
  for (const row of candidates) {
    const seen = perBiz.get(row.business_id) ?? 0;
    if (seen >= CALL_SUMMARY_BATCH_PER_BUSINESS) continue;
    perBiz.set(row.business_id, seen + 1);
    eligible.push(row);
    if (eligible.length >= batchLimit) break;
  }

  const doFetch = opts.fetchFn ?? fetch;
  const endpoint = `${opts.platformBaseUrl.replace(/\/$/, "")}/api/internal/summarize-call`;
  let dispatched = 0;
  let succeeded = 0;
  let failed = 0;
  const failures: Array<{ transcriptId: string; reason: string }> = [];

  // Sequential — one Gemini flash call each; parallelizing would just burst
  // the platform endpoint for no user-visible latency win.
  const loopStartMs = Date.now();
  for (const row of eligible) {
    if (Date.now() - loopStartMs >= timeBudgetMs) break;
    dispatched += 1;
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
    dispatched,
    succeeded,
    failed,
    deferred: eligible.length - dispatched,
    failures: failures.slice(0, 10)
  };
}
