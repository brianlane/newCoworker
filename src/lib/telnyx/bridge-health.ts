/**
 * Shared freshness classifier for per-tenant voice-bridge heartbeats.
 *
 * Both the tenant `PhoneNumberCard` and the admin `AssignDidPanel` pick
 * labels/copy off the same underlying staleness threshold. This module owns
 * the threshold and the state machine so they can't drift — each UI only
 * provides its own presentation layer on top of {@link BridgeHealthState}.
 *
 * The function accepts an injectable `now` so tests remain deterministic.
 */

/**
 * How long after the last heartbeat we still treat the bridge as healthy.
 * Matches the 3-minute window the voice bridge loop writes at.
 */
export const BRIDGE_FRESHNESS_THRESHOLD_MS = 3 * 60 * 1000;

/**
 * - `"pending"`  — no heartbeat yet (just after provisioning).
 * - `"healthy"`  — heartbeat within {@link BRIDGE_FRESHNESS_THRESHOLD_MS}.
 * - `"stale"`    — heartbeat older than threshold; needs operator attention.
 * - `"unknown"`  — heartbeat timestamp parsed to `NaN` (corrupt row).
 */
export type BridgeHealthState = "pending" | "healthy" | "stale" | "unknown";

export function resolveBridgeHealthState(
  heartbeatAt: string | null | undefined,
  now: Date = new Date(),
  thresholdMs: number = BRIDGE_FRESHNESS_THRESHOLD_MS
): BridgeHealthState {
  if (!heartbeatAt) return "pending";
  const ts = new Date(heartbeatAt).getTime();
  if (Number.isNaN(ts)) return "unknown";
  return now.getTime() - ts < thresholdMs ? "healthy" : "stale";
}
