/**
 * Durable outcome recording for the cron sweep fleet.
 *
 * Background (verified against production on 2026-08-08): pg_net's http_post
 * is asynchronous, so pg_cron finishes in milliseconds and
 * cron.job_run_details says "succeeded" no matter how the sweep actually
 * went. The only real record was net._http_response, retained ~6h with no
 * job column. Nothing watched it, so a sweep that answered HTTP 200 with a
 * full errors[] array looked identical to a clean run.
 *
 * Every cron-driven route now calls recordSweepRun when it finishes, writing
 * one public.cron_sweep_runs row. Two properties the watchdog depends on:
 *
 *  - A row is written on BOTH paths, success and thrown. That makes an
 *    ok=false row mean "the sweep ran and blew up" and error_count > 0 on an
 *    ok=true row mean "it ran and part of the work failed" (the silent-200
 *    case), which nothing could distinguish before.
 *  - A MISSING row is the signal for "never ran or never finished". A sweep
 *    killed by a timeout never reaches this code, so absence is evidence,
 *    not an inconclusive gap. That only holds while recordSweepRun never
 *    throws and never rejects: a recording failure must not turn a healthy
 *    sweep into a missing row, so the IO is wrapped and swallowed.
 *
 * The pure row builder is split from the IO so the 100% coverage gate can
 * reach every branch without a database.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

/**
 * A fleet-wide sweep can fail once per tenant, so an unbounded errors[] would
 * write megabytes on a bad night. Keep enough to diagnose, drop the rest, and
 * record the true count separately in error_count so the cap never hides the
 * scale of a failure.
 */
export const SWEEP_ERRORS_MAX = 25;

/** Individual error entries are truncated to keep one row small. */
export const SWEEP_ERROR_TEXT_MAX = 500;

/** Result keys that are not part of the "what did it count" summary. */
const NON_SUMMARY_KEYS = new Set(["errors", "failures", "durationMs"]);

/**
 * Header the Edge cron bridges stamp with their own function name, so a run
 * can say who invoked it.
 *
 * Needed because the cron bearer is not exclusive to pg_cron. The Meta
 * webhook kicks /api/internal/messenger-worker fire-and-forget on every
 * inbound message using the same INTERNAL_CRON_SECRET
 * (src/app/api/webhooks/meta/route.ts). Without a source, a busy Messenger
 * day would keep writing messenger-worker rows while its per-minute cron job
 * was dead, and the watchdog would never report the one sweep whose entire
 * purpose is being a retry net.
 *
 * This is attribution, not authorisation. It does not need to be
 * unforgeable: the bearer is already the security boundary, and the only
 * callers that send this header are our own bridges.
 */
export const CRON_SOURCE_HEADER = "x-cron-job";

/** Recorded when the caller was not one of the Edge cron bridges. */
export const DIRECT_SOURCE = "direct";

export type SweepRunInput = {
  /**
   * Route segment under src/app/api/internal/, e.g. "analytics-snapshot-sweep".
   * tests/cron-sweep-run-coverage.test.ts pins this to the directory name.
   */
  sweep: string;
  /** Edge bridge name from CRON_SOURCE_HEADER, or "direct". */
  source?: string;
  /** Date.now() captured at route entry. */
  startedAt: number;
  /** The route's own measured duration, the same number it returns. */
  durationMs: number;
  /** False when the sweep threw. */
  ok: boolean;
  /** The sweep's result body, when it produced one. */
  result?: unknown;
  /** The thrown value, when it did not. */
  error?: unknown;
};

export type SweepRunRow = {
  sweep: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  ok: boolean;
  error_count: number;
  errors: string[];
  summary: Record<string, unknown>;
  source: string;
};

/** One error entry as short readable text, whatever shape the sweep used. */
function errorText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, SWEEP_ERROR_TEXT_MAX);
  if (value instanceof Error) return value.message.slice(0, SWEEP_ERROR_TEXT_MAX);
  try {
    return JSON.stringify(value).slice(0, SWEEP_ERROR_TEXT_MAX);
  } catch {
    // Circular or otherwise unserialisable: never let a weird error value
    // cost us the whole row.
    return String(value).slice(0, SWEEP_ERROR_TEXT_MAX);
  }
}

/**
 * Pull the failure list out of a sweep result body.
 *
 * The fleet is not consistent about the key: most sweeps return `errors`,
 * the VPS and dispatch ones return `failures`, and a few return both. Both
 * are read and concatenated rather than picking a winner, because a sweep
 * that carries both uses them for different things.
 */
export function extractSweepErrors(result: unknown): unknown[] {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return [];
  const body = result as Record<string, unknown>;
  const out: unknown[] = [];
  if (Array.isArray(body.errors)) out.push(...body.errors);
  if (Array.isArray(body.failures)) out.push(...body.failures);
  return out;
}

/** Everything the sweep counted, minus the error lists and its own timing. */
export function extractSweepSummary(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (!NON_SUMMARY_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Shape one cron_sweep_runs row. Pure: finished_at is derived from
 * startedAt + durationMs rather than a fresh clock read, so the row's own
 * arithmetic is consistent and the function is trivially testable.
 */
export function buildSweepRunRow(input: SweepRunInput): SweepRunRow {
  const raw = input.ok
    ? extractSweepErrors(input.result)
    : [input.error === undefined ? "sweep threw a non-Error value" : input.error];
  return {
    sweep: input.sweep,
    started_at: new Date(input.startedAt).toISOString(),
    finished_at: new Date(input.startedAt + input.durationMs).toISOString(),
    duration_ms: input.durationMs,
    ok: input.ok,
    // The true count, before the cap below, so a capped list never
    // under-reports how bad the run was.
    error_count: raw.length,
    errors: raw.slice(0, SWEEP_ERRORS_MAX).map(errorText),
    summary: input.ok ? extractSweepSummary(input.result) : {},
    source: input.source ?? DIRECT_SOURCE
  };
}

/**
 * The success/error envelope every internal route answers with
 * (@/lib/api-response): successResponse -> {ok:true, data}, errorResponse ->
 * {ok:false, error:{code,message}}.
 */
export type ParsedSweepBody = {
  ok: boolean;
  result?: unknown;
  error?: unknown;
};

/**
 * Read a sweep's own answer back out of the Response it is about to return.
 *
 * Deliberately forgiving. A route that answered with something unparseable
 * still ran, and losing the row would look to the watchdog exactly like the
 * sweep never happening, which is a far worse lie than an empty summary.
 */
export function parseSweepBody(status: number, text: string): ParsedSweepBody {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: status < 400, error: status < 400 ? undefined : text.slice(0, SWEEP_ERROR_TEXT_MAX) };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: status < 400 };
  }
  const envelope = body as Record<string, unknown>;
  // Both signals must agree. A 500 carrying a stale ok:true, or a 200 whose
  // envelope says ok:false, is a failure either way.
  const ok = envelope.ok === true && status < 400;
  return {
    ok,
    result: envelope.data,
    error: ok ? undefined : (envelope.error ?? text.slice(0, SWEEP_ERROR_TEXT_MAX))
  };
}

/**
 * Wrap a cron route handler so every run lands in public.cron_sweep_runs.
 *
 * Used as `export const POST = withSweepRun("<route>", runSweep)` rather than
 * by editing each handler body, because the 22 pass-through routes measure
 * themselves inconsistently (some compute durationMs, some do not, some have
 * several return points). One wrapper gives all of them the same row, and
 * gives tests/cron-sweep-run-coverage.test.ts a single thing to enforce.
 *
 * Two behaviours worth stating outright:
 *
 *  - 401/403 are NOT recorded. Those are a bad cron bearer, so recording
 *    them would let any unauthenticated prod probe fabricate sweep runs and
 *    mask a genuinely missing one.
 *  - A handler that throws is recorded and then rethrown unchanged. The
 *    framework still produces its own 500; this only makes sure the blow-up
 *    is not silent.
 */
export function withSweepRun(
  sweep: string,
  handler: (request: Request) => Promise<Response>
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const startedAt = Date.now();
    const source = request.headers.get(CRON_SOURCE_HEADER)?.trim() || DIRECT_SOURCE;
    let response: Response;
    try {
      response = await handler(request);
    } catch (err) {
      await recordSweepRun({
        sweep,
        source,
        startedAt,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: err
      });
      throw err;
    }
    const durationMs = Date.now() - startedAt;
    if (response.status === 401 || response.status === 403) return response;

    // Clone before reading: the caller still needs an unconsumed body.
    let text = "";
    try {
      text = await response.clone().text();
    } catch (err) {
      logger.warn("withSweepRun could not read the sweep response body", {
        sweep,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    const parsed = parseSweepBody(response.status, text);
    await recordSweepRun({
      sweep,
      source,
      startedAt,
      durationMs,
      ok: parsed.ok,
      result: parsed.result,
      error: parsed.error
    });
    return response;
  };
}

/**
 * Write the run to public.cron_sweep_runs. Never throws and never rejects:
 * a bookkeeping failure must not fail the sweep that already did its work,
 * and must not be able to fabricate the "missing row" the watchdog reads as
 * an outage. A failed write is logged loudly instead.
 */
export async function recordSweepRun(input: SweepRunInput): Promise<void> {
  const row = buildSweepRunRow(input);
  try {
    const supabase = await createSupabaseServiceClient();
    const { error } = await supabase.from("cron_sweep_runs").insert(row);
    if (error) {
      logger.error("recordSweepRun insert failed", {
        sweep: input.sweep,
        error: error.message
      });
    }
  } catch (err) {
    logger.error("recordSweepRun threw", {
      sweep: input.sweep,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
