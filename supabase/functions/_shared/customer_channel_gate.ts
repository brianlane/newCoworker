/**
 * Precedence gate for customer-facing Telnyx channels (SMS + voice).
 *
 *   is_paused = true                          → "paused"
 *   customer_channels_enabled = false + forward→ "safe_mode_forward"
 *   customer_channels_enabled = false w/o fwd → "paused"  (fail-safe)
 *   otherwise                                  → "normal"
 *
 * Kept UI/DB-free so it can be unit-tested from Node or Deno; callers pass in
 * the already-loaded flags. See supabase/functions/*_test.ts for the truth
 * table.
 */

export type CustomerChannelFlags = {
  isPaused: boolean;
  customerChannelsEnabled: boolean;
  forwardToE164: string | null | undefined;
};

export type CustomerChannelGate =
  | { kind: "normal" }
  | { kind: "paused" }
  | { kind: "safe_mode_forward"; forwardToE164: string };

export function evaluateCustomerChannelGate(
  flags: CustomerChannelFlags
): CustomerChannelGate {
  if (flags.isPaused) return { kind: "paused" };

  if (flags.customerChannelsEnabled !== false) return { kind: "normal" };

  const forward = (flags.forwardToE164 ?? "").trim();
  if (!forward) {
    // Fail-safe: Safe Mode on but no destination → do not answer the
    // customer, matching the kill-switch hard-stop behaviour. The dashboard
    // UI prevents this state, but the webhook must still be deterministic if
    // an admin clears the number directly in the DB.
    return { kind: "paused" };
  }

  return { kind: "safe_mode_forward", forwardToE164: forward };
}
