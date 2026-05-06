/**
 * Nightly cross-channel customer memory summarizer sweep.
 *
 * The fire-and-forget summarizer attached to inbound SMS / voice
 * paths catches the live signal, but it can leak when:
 *   - the inbound worker invocation gets pre-empted before it dispatches
 *     the fire-and-forget;
 *   - the gate (interaction_count >= 3, debounce 30s) was satisfied at
 *     interaction time but the dispatch raced with another writer that
 *     reset the counter back below threshold;
 *   - a customer was bumped via voice but the fire-and-forget hook is
 *     not yet wired (Phase 5);
 *   - Rowboat returned an error and the dispatch logged-and-dropped.
 *
 * This sweep runs once per night at off-peak (default 04:00 UTC) and
 * walks every customer_memories row whose:
 *   (a) interaction_count >= SUMMARY_INTERACTION_THRESHOLD (3), AND
 *   (b) last_summarized_at is NULL OR older than SUMMARY_DEBOUNCE_MS,
 *
 * dispatching summarizeCustomerMemoryAndLog for each. The summarizer
 * itself re-checks the gate and persists a counter reset on success,
 * so this loop is idempotent: re-running it on the same row produces
 * a "below_threshold" / "debounced" skip without any side effect.
 *
 * Owner-confirmed contract from the cross-channel plan:
 *   "Run nightly batch through a low-priority queue so it never preempts
 *    a live customer call/text."
 *
 * Implementation choices that reflect that:
 *   - Hard cap on rows processed per invocation (BATCH_LIMIT) so a
 *     pathological backlog (e.g. cron didn't run for a week) doesn't
 *     hold the function past the 150s Edge ceiling.
 *   - Sequential dispatch (no Promise.all). The per-tenant Ollama is
 *     small; parallelizing would have one tenant's nightly sweep
 *     compete with another tenant's live customer call. Sequential
 *     keeps each Rowboat call inside the budget pool of its own
 *     business.
 *   - Per-business throttle: when more than BATCH_PER_BUSINESS rows
 *     show up for the same business, we summarize the first
 *     BATCH_PER_BUSINESS and defer the rest to the next sweep. Stops
 *     a single tenant's noisy customer base from monopolizing the
 *     batch.
 *   - Errors are swallowed and counted, never re-thrown. We need every
 *     pending row to get its chance even if one tenant's VPS is down.
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";

/** Hard cap on rows per invocation. Sized so even at ~5s/row we stay
 * inside the Edge 150s ceiling (with some buffer for the dispatch
 * round trip from the Next.js summarizer worker). */
const BATCH_LIMIT = 25;

/** Per-business cap so one tenant's queue can't monopolize the batch. */
const BATCH_PER_BUSINESS = 5;

/** Threshold/debounce mirrored from src/lib/customer-memory/summarizer.ts.
 * Kept in sync via tests/customer-memory-cron-contract.test.ts; the
 * inline duplication here is intentional (Edge runtime can't import
 * from src/). */
const SUMMARY_INTERACTION_THRESHOLD = 3;
const SUMMARY_DEBOUNCE_MS = 30_000;

/**
 * The cron only QUEUES rows. The Next.js summarizer worker (regular
 * /api/internal/summarize-customer endpoint) actually runs the
 * Rowboat call and DB writes, since the production summarizer is
 * Next.js code (not Edge) — it imports from @/lib/* and uses the
 * platform Supabase client. This Edge function is the cheap
 * scan-and-dispatch layer.
 */
type CustomerMemoryRow = {
  id: string;
  business_id: string;
  customer_e164: string;
  interaction_count: number;
  last_summarized_at: string | null;
};

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!(await assertCronAuth(req))) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const platformBase = Deno.env.get("PLATFORM_PUBLIC_BASE_URL") ?? "";
  const platformBearer = Deno.env.get("INTERNAL_CRON_SECRET") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return new Response("Server misconfigured", { status: 500 });
  }
  if (!platformBase || !platformBearer) {
    // Without these we can't dispatch — be loud rather than silently
    // succeed-and-do-nothing.
    return new Response(
      JSON.stringify({
        ok: false,
        error:
          "missing PLATFORM_PUBLIC_BASE_URL or INTERNAL_CRON_SECRET — set them on the Edge function"
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Fetch eligible rows. Filter is pure SQL (cheap on the indexed
  // last_summarized_at column added by the customer_memories
  // migration) so the planner doesn't have to scan every row in the
  // table.
  const cutoff = new Date(Date.now() - SUMMARY_DEBOUNCE_MS).toISOString();
  const { data: rowsData, error: queryErr } = await supabase
    .from("customer_memories")
    .select("id, business_id, customer_e164, interaction_count, last_summarized_at")
    .gte("interaction_count", SUMMARY_INTERACTION_THRESHOLD)
    .or(`last_summarized_at.is.null,last_summarized_at.lt.${cutoff}`)
    // Oldest-pending first so a steady backlog doesn't starve the
    // earliest unprocessed customers.
    .order("last_summarized_at", { ascending: true, nullsFirst: true })
    .limit(BATCH_LIMIT * 2); // wide net; per-business throttle applied below

  if (queryErr) {
    console.error("customer_memories query failed", queryErr);
    return new Response(
      JSON.stringify({ ok: false, error: "query_failed", detail: queryErr.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const rows = (rowsData as CustomerMemoryRow[] | null) ?? [];

  // Apply per-business cap.
  const perBiz = new Map<string, number>();
  const eligible: CustomerMemoryRow[] = [];
  for (const row of rows) {
    const seen = perBiz.get(row.business_id) ?? 0;
    if (seen >= BATCH_PER_BUSINESS) continue;
    perBiz.set(row.business_id, seen + 1);
    eligible.push(row);
    if (eligible.length >= BATCH_LIMIT) break;
  }

  let succeeded = 0;
  let failed = 0;
  const failures: Array<{ businessId: string; customerE164: string; reason: string }> = [];
  // Sequential dispatch — see file header for why.
  for (const row of eligible) {
    try {
      const res = await fetch(
        `${platformBase.replace(/\/$/, "")}/api/internal/summarize-customer`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${platformBearer}`
          },
          body: JSON.stringify({
            businessId: row.business_id,
            customerE164: row.customer_e164,
            // Marks this dispatch as cron-originated for telemetry.
            source: "nightly_sweep"
          })
        }
      );
      if (res.ok) {
        succeeded += 1;
      } else {
        failed += 1;
        const text = await res.text().catch(() => "");
        failures.push({
          businessId: row.business_id,
          customerE164: row.customer_e164,
          reason: `http_${res.status}: ${text.slice(0, 120)}`
        });
      }
    } catch (err) {
      failed += 1;
      failures.push({
        businessId: row.business_id,
        customerE164: row.customer_e164,
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const summary = {
    eligible_total: rows.length,
    dispatched: eligible.length,
    succeeded,
    failed,
    deferred: rows.length - eligible.length,
    failures: failures.slice(0, 10) // first 10 only — telemetry payload cap
  };
  await telemetryRecord(supabase, "customer_memory_summarize_sweep", summary);

  return new Response(JSON.stringify({ ok: true, ...summary }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});
