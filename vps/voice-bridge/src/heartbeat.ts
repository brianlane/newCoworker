/**
 * Voice-bridge heartbeat loop.
 *
 * The dashboard's `PhoneNumberCard` reads
 * `business_telnyx_settings.bridge_last_heartbeat_at` to classify the bridge
 * as `pending` (never beat) / `healthy` (recent) / `stale` (old). Pre-fix,
 * heartbeats were only emitted from inside the WebSocket upgrade handler, so
 * a freshly provisioned tenant who hadn't yet received a call would render
 * `pending` forever with the misleading copy "your voice bridge hasn't checked
 * in yet — this is normal right after provisioning". Owners assumed voice was
 * broken when in fact the container was healthy and just waiting for traffic.
 *
 * Extracting into its own module so it's importable from tests without
 * booting the full `main()` (which spins up the HTTP + WS server and reads
 * env vars at module load).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Cadence of the idle heartbeat loop. Must be safely below
 * `BRIDGE_FRESHNESS_THRESHOLD_MS` (3 minutes) in
 * `src/lib/telnyx/bridge-health.ts` so a healthy idle bridge never flips to
 * `stale` between writes. 60 s leaves ample headroom even if a single upsert
 * times out, and matches the cadence used by other always-on services on the
 * VPS (rowboat keep-warm, jobs-worker poller).
 */
export const IDLE_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Write a single heartbeat row. Errors are intentionally swallowed by the
 * caller — Supabase upsert failures are transient and the next interval will
 * retry; a one-off network blip should not crash the bridge process and
 * disconnect live calls.
 */
export async function writeHeartbeat(
  supabase: SupabaseClient,
  businessId: string,
  now: () => string = () => new Date().toISOString()
): Promise<void> {
  const ts = now();
  await supabase
    .from("business_telnyx_settings")
    .upsert(
      {
        business_id: businessId,
        bridge_last_heartbeat_at: ts,
        updated_at: ts
      },
      { onConflict: "business_id" }
    );
}

/**
 * Run a forever loop that pings Supabase with `bridge_last_heartbeat_at` so
 * the dashboard can distinguish "bridge is up and idle" from "bridge has
 * never started" / "bridge has crashed".
 *
 * Returns the timer so callers can `clearInterval` it from tests; main()
 * intentionally never clears it because the bridge process is the lifecycle.
 */
export function startIdleHeartbeatLoop(
  supabase: SupabaseClient,
  businessId: string,
  intervalMs: number = IDLE_HEARTBEAT_INTERVAL_MS,
  now: () => string = () => new Date().toISOString()
): NodeJS.Timeout {
  // Eager first beat so the dashboard updates within seconds of `systemctl
  // restart` rather than waiting a full interval.
  void writeHeartbeat(supabase, businessId, now);
  return setInterval(() => {
    void writeHeartbeat(supabase, businessId, now);
  }, intervalMs);
}
