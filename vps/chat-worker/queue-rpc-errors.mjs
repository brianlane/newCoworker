// ---------------------------------------------------------------------------
// Transient-failure classification for the worker's queue RPCs (claim +
// stale-reclaim).
//
// These RPCs run on every 30s sweep, so a one-off VPS->Supabase blip is
// harmless by design: nothing is lost, the next sweep retries (reliability
// contract at the top of worker.mjs). But logging every blip at `error` puts a
// red row in the admin System Errors feed each time any tenant box hiccups.
// Treatment (PR #678):
//   * a transient failure gets ONE inline retry after QUEUE_RPC_RETRY_MS
//     (sweep RPCs only: claims are re-driven by Realtime / the next sweep);
//   * a failure that survives the retry logs `warn` (`<event>_transient`)
//     until QUEUE_RPC_ERROR_AFTER consecutive failures of that RPC (~90s of
//     sustained connectivity loss at the 30s sweep), then it escalates to
//     `error` under the original event name so existing alerting still fires;
//   * a real defect (a missing RPC, a bad grant) keeps its original level
//     immediately: that is not network weather.
//
// Classification reads the postgrest-js response SHAPE, not the error prose.
// The first cut of this matched a regex against error.message, which was
// written for the errors undici *throws*. An Envoy 503 from Supabase's edge
// gateway is a successful HTTP response carrying a non-JSON body, so nothing
// throws and postgrest-js hands back `{ message: <raw body> }`, prose that
// matched nothing, so a single blip skipped the retry AND went straight to
// `error`. Observed once on Scar Fairy's box, 2026-08-14:
//   "upstream connect error or disconnect/reset before headers. retried and
//    the latest reset reason: remote connection failure, transport failure
//    reason: delayed connect error: 111"      (111 = ECONNREFUSED)
// The three failure shapes separate cleanly without reading any English:
//
//   | failure                              | status      | error.code       |
//   | ------------------------------------ | ----------- | ---------------- |
//   | undici throw (DNS, reset, timeout)   | 0           | ""               |
//   | gateway 5xx, non-JSON body           | 502/503/504 | absent           |
//   | real PostgREST / Postgres error      | 4xx         | 42883, PGRST202… |
//
// The prose regex survives only as a fallback for a response with no usable
// status, so a future client that stops populating it degrades to the old
// behavior rather than misclassifying everything.
// ---------------------------------------------------------------------------

/** Pause before the single inline retry of a sweep RPC. */
export const QUEUE_RPC_RETRY_MS = 2000;

/** Consecutive transient failures of one RPC before it escalates to `error`. */
export const QUEUE_RPC_ERROR_AFTER = 3;

const TRANSIENT_RPC_ERROR_RE =
  /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR|socket hang up|network|abort|upstream connect error|delayed connect error|reset before headers|no healthy upstream|upstream request timeout|connection (?:refused|failure|reset|timed out)/i;

/**
 * Last-resort classification from an error message alone. Only consulted when
 * the response carried no usable HTTP status.
 */
export function isTransientRpcError(message) {
  return TRANSIENT_RPC_ERROR_RE.test(String(message || ""));
}

/** Human-readable failure text for the log line. */
export function describeQueueRpcError(result) {
  const error = result?.error;
  const message = typeof error === "string" ? error : error?.message;
  return String(message || result?.statusText || "unknown error");
}

/**
 * "transient" (network weather the next sweep recovers from) vs "defect" (a
 * real bug that should go red now). Takes the whole postgrest-js response
 * `{ error, status, statusText }`, not just the message.
 */
export function classifyQueueRpcFailure(result) {
  const status = result?.status;
  const error = result?.error;

  // The round trip never completed: postgrest-js reports status 0 when the
  // underlying fetch threw (DNS failure, connection reset, socket timeout).
  if (status === 0) return "transient";

  // Something answered, but it was not PostgREST. 502/503/504 come from
  // Supabase's edge gateway when it cannot reach the API behind it.
  if (typeof status === "number" && status >= 500) return "transient";

  // PostgREST and Postgres always stamp a `code` on their JSON errors
  // (SQLSTATE like 42883 / 42501, or PGRST***). That is the database talking,
  // so it is a real defect: a missing RPC, a bad grant, a broken argument.
  if (typeof error?.code === "string" && error.code !== "") return "defect";

  // No status to judge by and no code. A 4xx with neither is an auth or
  // routing problem, not weather, so the prose regex has to clear it.
  return isTransientRpcError(describeQueueRpcError(result)) ? "transient" : "defect";
}

/**
 * The warn-then-escalate ladder. Returns the log line to emit rather than
 * logging itself, so it stays a pure function of the failures it has seen.
 *
 * `record()` -> `{ level, event, data }`; `clear()` on the RPC's next success.
 */
export function createQueueRpcFailureTracker({ errorAfter = QUEUE_RPC_ERROR_AFTER } = {}) {
  const consecutive = new Map();
  return {
    record(event, result, { nonTransientLevel = "error" } = {}) {
      const error = describeQueueRpcError(result);
      if (classifyQueueRpcFailure(result) === "defect") {
        consecutive.delete(event);
        return { level: nonTransientLevel, event, data: { error } };
      }
      const consecutiveFailures = (consecutive.get(event) || 0) + 1;
      consecutive.set(event, consecutiveFailures);
      if (consecutiveFailures >= errorAfter) {
        return { level: "error", event, data: { error, consecutiveFailures } };
      }
      return {
        level: "warn",
        event: `${event}_transient`,
        data: { error, consecutiveFailures }
      };
    },
    clear(event) {
      consecutive.delete(event);
    }
  };
}
