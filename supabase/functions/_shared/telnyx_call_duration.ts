/**
 * How long was this call, according to a Telnyx hangup webhook?
 *
 * Lived as a private helper inside telnyx-voice-call-end until Aug 2026, when
 * it turned out to answer "unknown" every single time. It read only
 * `call_duration`, and Telnyx's `call.hangup` / `call.ended` payloads do not
 * carry that field: they carry `start_time` and `end_time`. Two things ran on
 * the answer, and both were silently degraded fleet-wide:
 *
 * - `voice_settlements.telnyx_reported_duration_seconds` was NULL on every row
 *   ever written.
 * - `meterForwardedCallSeconds` bailed with `no_duration` on every forwarded /
 *   warm-transferred leg, so the carrier time the platform pays Telnyx for
 *   human conversation never counted against a tenant's voice pool and never
 *   reached the refund withholding in `loadBillableUsageSince`. Zero
 *   `voice_forwarded_call_metered` telemetry rows existed fleet-wide.
 *
 * `call_duration` is still read FIRST so nothing changes if Telnyx starts
 * sending it (or if a caller synthesizes it); the timestamp span is the
 * fallback, not the replacement.
 *
 * Extracted to `_shared` so it is directly testable, the Edge function itself
 * is not imported by the vitest suite.
 */

/**
 * Longest span we will believe from a webhook.
 *
 * The fallback subtracts two timestamps the sender controls. A malformed or
 * clock-skewed pair (a `start_time` defaulted to the epoch is the classic one)
 * would otherwise meter a tenant for decades of minutes in a single call, and
 * the meter is deliberately a never-refuses post-hoc path with no ceiling of
 * its own. Telnyx caps calls well under this; anything longer is a bad payload,
 * not a long conversation, so we return null and let the caller record
 * "unknown" rather than bill nonsense.
 */
export const MAX_PLAUSIBLE_CALL_SECONDS = 24 * 60 * 60;

/** Milliseconds since epoch for an ISO-8601 timestamp, or null if unusable. */
function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Seconds of call duration from a Telnyx voice webhook payload, or null when
 * the payload gives us nothing defensible to bill.
 *
 * Order: explicit `call_duration` (number or numeric string), then
 * `end_time - start_time`. Always floored to a whole second.
 */
export function parseCallDurationSeconds(
  payload: Record<string, unknown>
): number | null {
  const v = payload["call_duration"];
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
    return Math.floor(v);
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }

  // Fallback: the span Telnyx actually reports on hangup.
  const startMs = parseTimestampMs(payload["start_time"]);
  const endMs = parseTimestampMs(payload["end_time"]);
  if (startMs === null || endMs === null) return null;

  const seconds = (endMs - startMs) / 1000;
  // Negative means the pair is inconsistent (clock skew, or the fields were
  // swapped upstream). Not zero-clamped: a wrong span is not evidence of a
  // zero-length call, and billing 0 would hide the problem instead of
  // surfacing it as `no_duration` telemetry.
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds > MAX_PLAUSIBLE_CALL_SECONDS) return null;
  return Math.floor(seconds);
}
