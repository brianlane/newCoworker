/**
 * Fleet-wide outbound call concurrency config (pure, env-driven).
 *
 * The Telnyx account allows a fixed number of concurrent outbound calls
 * ACROSS the fleet (min of connection channel_limit, outbound voice profile
 * concurrent_call_limit, and the account-level pool; raises to the account
 * pool go through Telnyx support and cannot be automated). Two env knobs
 * derive the pre-dial gate:
 *
 *   TELNYX_ACCOUNT_CHANNEL_LIMIT   the granted pool. Update this ONE secret
 *                                  when Telnyx confirms a raise; everything
 *                                  derives. Default 10 (the pool granted at
 *                                  Level 2 verification).
 *   PLATFORM_OUTBOUND_HEADROOM     channels held back from flow-placed dials
 *                                  for legs the platform does not meter at
 *                                  dial time: reach_teammate B legs and warm
 *                                  transfers of live callers. A transfer that
 *                                  fails for capacity strands a HUMAN mid
 *                                  call, so those legs get the reserve.
 *                                  Default 3.
 *
 * Gate = max(1, limit - headroom). Clamped to >= 1 so a misconfigured pair
 * (headroom >= limit) degrades to "one at a time", never "no dialing at all".
 */

export const DEFAULT_ACCOUNT_CHANNEL_LIMIT = 10;
export const DEFAULT_OUTBOUND_HEADROOM = 3;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const text = (raw ?? "").trim();
  // Unset/blank must fall back, not parse as Number("") === 0: a zero limit
  // here would throttle the whole fleet to one concurrent dial.
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * The fleet-wide cap on concurrently in-flight FLOW-PLACED outbound calls,
 * from the env. `env` is injected (Deno.env.get in edge functions) so this
 * stays unit-testable under Node.
 */
export function platformMaxConcurrentOutbound(env: (name: string) => string | undefined): number {
  const limit = readPositiveInt(env("TELNYX_ACCOUNT_CHANNEL_LIMIT"), DEFAULT_ACCOUNT_CHANNEL_LIMIT);
  const headroom = readPositiveInt(env("PLATFORM_OUTBOUND_HEADROOM"), DEFAULT_OUTBOUND_HEADROOM);
  return Math.max(1, limit - headroom);
}
