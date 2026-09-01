/**
 * Fleet-wide outbound call concurrency config.
 *
 * The Telnyx account allows a fixed number of concurrent outbound calls
 * ACROSS the fleet (min of connection channel_limit, outbound voice profile
 * concurrent_call_limit, and the account-level pool; raises to the account
 * pool go through Telnyx support and cannot be automated). The granted pool
 * CHANGES over time as support tickets land, so it lives in the DATABASE
 * (admin_platform_settings key "telnyx_capacity"), not in env: one row
 * update applies everywhere at once, with no secret rotation across
 * environments and no redeploy.
 *
 *   { "account_channel_limit": 500, "platform_outbound_headroom": 3 }
 *
 * account_channel_limit    the pool Telnyx granted (ticket #582143 raised
 *                          it to 100 on 2026-08-16; ticket #624702 raised
 *                          it to 500 on 2026-08-31).
 * platform_outbound_headroom  channels held back from flow-placed dials
 *                          fleet-wide, insurance against config drift. The
 *                          protection that matters per tenant is
 *                          voice_outbound_dial_headroom on
 *                          business_telnyx_settings.
 *
 * Env vars TELNYX_ACCOUNT_CHANNEL_LIMIT / PLATFORM_OUTBOUND_HEADROOM remain
 * as the fallback when the row is missing or unreadable (and for local
 * debug tooling), then the hard defaults. Gate = max(1, limit - headroom).
 */

export const DEFAULT_ACCOUNT_CHANNEL_LIMIT = 10;
export const DEFAULT_OUTBOUND_HEADROOM = 3;

/** admin_platform_settings key carrying the capacity config. */
export const TELNYX_CAPACITY_SETTINGS_KEY = "telnyx_capacity";

export type TelnyxCapacityConfig = {
  accountChannelLimit: number;
  platformOutboundHeadroom: number;
};

function readPositiveInt(raw: unknown, fallback: number): number {
  if (typeof raw === "string") {
    const text = raw.trim();
    // Unset/blank must fall back, not parse as Number("") === 0: a zero
    // limit here would throttle the whole fleet to one concurrent dial.
    if (!text) return fallback;
    raw = Number(text);
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return fallback;
  return Math.floor(raw);
}

/**
 * Parse the settings row's jsonb value (pure). Missing/malformed fields
 * fall back to the env, then the defaults.
 */
export function parseTelnyxCapacityConfig(
  raw: unknown,
  env: (name: string) => string | undefined
): TelnyxCapacityConfig {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const envLimit = readPositiveInt(env("TELNYX_ACCOUNT_CHANNEL_LIMIT"), DEFAULT_ACCOUNT_CHANNEL_LIMIT);
  const envHeadroom = readPositiveInt(env("PLATFORM_OUTBOUND_HEADROOM"), DEFAULT_OUTBOUND_HEADROOM);
  return {
    accountChannelLimit: readPositiveInt(row.account_channel_limit, envLimit),
    platformOutboundHeadroom: readPositiveInt(row.platform_outbound_headroom, envHeadroom)
  };
}

/** The pre-dial gate derived from a config. Clamped so a misconfigured pair degrades to one-at-a-time dialing, never zero. */
export function gateFromConfig(config: TelnyxCapacityConfig): number {
  return Math.max(1, config.accountChannelLimit - config.platformOutboundHeadroom);
}

type SettingsSupabase = {
  from(table: string): {
    select(cols: string): {
      eq(
        col: string,
        val: unknown
      ): { maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }> };
    };
  };
};

/**
 * Read the capacity config from admin_platform_settings. Never throws: any
 * read failure degrades to env fallback then defaults (a DB blip must not
 * stop the fleet dialing).
 */
export async function readTelnyxCapacityConfig(
  supabase: SettingsSupabase,
  env: (name: string) => string | undefined
): Promise<TelnyxCapacityConfig> {
  try {
    const { data, error } = await supabase
      .from("admin_platform_settings")
      .select("value")
      .eq("key", TELNYX_CAPACITY_SETTINGS_KEY)
      .maybeSingle();
    if (error) {
      console.error("platform-capacity: settings read failed", error.message);
      return parseTelnyxCapacityConfig(null, env);
    }
    return parseTelnyxCapacityConfig((data as { value?: unknown } | null)?.value ?? null, env);
  } catch (err) {
    console.error("platform-capacity: settings read threw", err);
    return parseTelnyxCapacityConfig(null, env);
  }
}

/**
 * Back-compat helper for env-only callers (local debug tooling): the fleet
 * gate from env alone.
 */
export function platformMaxConcurrentOutbound(env: (name: string) => string | undefined): number {
  return gateFromConfig(parseTelnyxCapacityConfig(null, env));
}
