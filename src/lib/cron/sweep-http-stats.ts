/**
 * Aggregation for the fleet's cron HTTP outcomes (debug/cron-http-stats.ts).
 *
 * pg_net's http_post is ASYNCHRONOUS: a pg_cron run only enqueues the request
 * and finishes in milliseconds, so cron.job_run_details says nothing about
 * how the chain went. The real outcomes, including timeouts against
 * timeout_milliseconds and the 150s Edge ceiling, land in net._http_response,
 * which is retained for roughly six hours and has no job column.
 *
 * Attribution therefore comes from the response body: every internal sweep
 * returns a distinctive JSON shape, so the sorted key set is a stable group
 * key ("signature"), and most bodies carry the route's own durationMs. The
 * durations are the route's self-report, which is exactly the number the
 * KNOWN_ABOVE_EDGE_CEILING debate needs: how long the sweeps actually run.
 */

export type HttpResponseRow = {
  statusCode: number;
  timedOut: boolean;
  errorMsg: string | null;
  contentType: string | null;
  content: string | null;
  created: Date;
};

/**
 * Stable group key for a response body: the sorted key set of the `data`
 * envelope when there is one (prefixed "data:"), else of the top level.
 * durationMs is dropped so the timing field never splits a group. Non-JSON
 * and non-object bodies get fixed labels rather than vanishing.
 *
 * A keys-only signature cannot separate two sweeps that share a shape
 * (contract-term-nudge and monthly-intro-nudge both return
 * {scanned,sent,skipped,errors}). A route that carries a string `sweep`
 * field self-identifies, and that VALUE wins over the shape. Any sweep whose
 * shape collides with another must add one.
 */
export function bodySignature(content: string | null): string {
  if (content === null || content === "") return "(empty)";
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return "(unparseable)";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "(non-object)";
  }
  const root = parsed as Record<string, unknown>;
  const data = root.data;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const envelope = data as Record<string, unknown>;
    if (typeof envelope.sweep === "string") return `sweep:${envelope.sweep}`;
    const keys = Object.keys(envelope).filter((k) => k !== "durationMs").sort();
    return `data:{${keys.join(",")}}`;
  }
  if (typeof root.sweep === "string") return `sweep:${root.sweep}`;
  const keys = Object.keys(root).filter((k) => k !== "durationMs").sort();
  return `{${keys.join(",")}}`;
}

/** The route's self-reported wall time; envelope wins over root. */
export function extractDurationMs(content: string | null): number | null {
  if (content === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const data = root.data;
  const candidate =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>).durationMs
      : root.durationMs;
  const fallback = candidate === undefined ? root.durationMs : candidate;
  return typeof fallback === "number" && Number.isFinite(fallback) && fallback >= 0
    ? fallback
    : null;
}

/** Linear-interpolated percentile over the values; null on an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export type SignatureGroup = {
  signature: string;
  n: number;
  ok2xx: number;
  http4xx: number;
  http5xx: number;
  timedOut: number;
  errored: number;
  durations: { n: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null };
};

export type SweepHttpReport = {
  total: number;
  errored: number;
  timedOut: number;
  window: { oldest: Date; newest: Date } | null;
  groups: SignatureGroup[];
};

/**
 * One report over a net._http_response extract. Groups are ordered worst
 * observed duration first (groups with no duration data last), so the routes
 * that matter for the 150s-ceiling question surface at the top.
 */
export function summarizeResponses(rows: HttpResponseRow[]): SweepHttpReport {
  const groups = new Map<string, { g: SignatureGroup; durations: number[] }>();
  let oldest: Date | null = null;
  let newest: Date | null = null;
  let errored = 0;
  let timedOut = 0;

  for (const rowItem of rows) {
    if (oldest === null || rowItem.created < oldest) oldest = rowItem.created;
    if (newest === null || rowItem.created > newest) newest = rowItem.created;
    if (rowItem.errorMsg !== null) errored += 1;
    if (rowItem.timedOut) timedOut += 1;

    const signature = bodySignature(rowItem.content);
    let entry = groups.get(signature);
    if (!entry) {
      entry = {
        g: {
          signature,
          n: 0,
          ok2xx: 0,
          http4xx: 0,
          http5xx: 0,
          timedOut: 0,
          errored: 0,
          durations: { n: 0, p50Ms: null, p95Ms: null, maxMs: null }
        },
        durations: []
      };
      groups.set(signature, entry);
    }
    entry.g.n += 1;
    if (rowItem.statusCode >= 200 && rowItem.statusCode < 300) entry.g.ok2xx += 1;
    else if (rowItem.statusCode >= 400 && rowItem.statusCode < 500) entry.g.http4xx += 1;
    else if (rowItem.statusCode >= 500) entry.g.http5xx += 1;
    if (rowItem.timedOut) entry.g.timedOut += 1;
    if (rowItem.errorMsg !== null) entry.g.errored += 1;

    const durationMs = extractDurationMs(rowItem.content);
    if (durationMs !== null) entry.durations.push(durationMs);
  }

  const finished: SignatureGroup[] = [];
  for (const { g, durations } of groups.values()) {
    g.durations = {
      n: durations.length,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      maxMs: durations.length === 0 ? null : Math.max(...durations)
    };
    finished.push(g);
  }
  finished.sort((a, b) => (b.durations.maxMs ?? -1) - (a.durations.maxMs ?? -1));

  return {
    total: rows.length,
    errored,
    timedOut,
    window: oldest === null || newest === null ? null : { oldest, newest },
    groups: finished
  };
}
