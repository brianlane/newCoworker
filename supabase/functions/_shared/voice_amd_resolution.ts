/**
 * Bounded resolution for a machine verdict that Telnyx never resolves.
 *
 * Under `premium_ios_call_screening_detection` a `machine` verdict is
 * PROVISIONAL: the AMD handler stamps it and defers every action (speak the
 * voicemail script, hang up a scriptless leg) to the resolution event, a
 * greeting.ended beep or a call-screening detection. That design assumed the
 * resolution event always comes. Since 2026-08-25 Telnyx has delivered ZERO
 * greeting events (memory project_telnyx_premium_amd_event_collapse), so a
 * confirmed machine verdict changed nothing about the call: the model kept
 * talking into recordings, and the deterministic voicemail path was dead
 * even on the calls where detection worked.
 *
 * This module is the pure decision for the sweep that closes that gap: N
 * seconds after an UNRESOLVED machine stamp, act anyway. The decision is
 * deliberately conservative in exactly the direction the provisional design
 * cares about:
 *
 *   - `ios_screening` on the leg means a live person is deciding whether to
 *     pick up: never act. (The screening event also clears the machine stamp,
 *     so this is belt and braces.)
 *   - The grace period is long enough that a screening detection, a greeting
 *     beep, or the model's own `voicemail_reached` claim would each have
 *     arrived first on a healthy call. The sweep only ever acts on legs the
 *     event contract already abandoned.
 *   - Anything unrecognized or half-stamped is skipped, not acted on. Acting
 *     wrongly cuts a live conversation; skipping costs one more model-driven
 *     voicemail, which is yesterday's status quo.
 *
 * The rollout gate (`voice_amd_resolution` in admin_platform_settings) keeps
 * the sweep OFF until a tenant is explicitly enrolled, so the change can be
 * measured against real calls per feedback_score_prompt_changes_against_outcomes.
 */

/**
 * How long an UNRESOLVED machine stamp must stand before the sweep acts.
 *
 * Chosen against the healthy-period event timings (Aug 12-24): greeting.ended
 * arrived 5-10s after the verdict, screening (had it ever fired) inside the
 * same window, and the model's voicemail_reached claim typically landed
 * within ~20s of the verdict (greeting end plus beep). At 25s every
 * legitimate resolver has had its turn, while the mailbox (recording limits
 * run 60-180s) still has ample room for the script.
 */
export const AMD_RESOLUTION_GRACE_MS = 25_000;

/**
 * Stamps older than this are stale sessions (a crashed leg, a lost hangup),
 * not live calls: acting would issue Telnyx commands against dead ids.
 * Mirrors the 30-minute window in the pg_cron EXISTS guard.
 */
export const AMD_RESOLUTION_MAX_AGE_MS = 30 * 60 * 1000;

/** admin_platform_settings key holding the rollout gate. */
export const AMD_RESOLUTION_SETTINGS_KEY = "voice_amd_resolution";

export type AmdResolutionConfig = {
  enabled: boolean;
  /** Enroll every business at once (the post-measurement end state). */
  allBusinesses: boolean;
  /** Explicitly enrolled businesses (the measurement arm). */
  businessIds: ReadonlySet<string>;
};

const DISABLED: AmdResolutionConfig = {
  enabled: false,
  allBusinesses: false,
  businessIds: new Set()
};

/**
 * Parse the settings row value. Anything missing or malformed disables the
 * sweep: this feature forces irreversible call actions, so it fails OFF.
 */
export function parseAmdResolutionConfig(raw: unknown): AmdResolutionConfig {
  if (typeof raw !== "object" || raw === null) return DISABLED;
  const value = raw as { enabled?: unknown; all_businesses?: unknown; business_ids?: unknown };
  if (value.enabled !== true) return DISABLED;
  const ids = Array.isArray(value.business_ids)
    ? value.business_ids.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
  return {
    enabled: true,
    allBusinesses: value.all_businesses === true,
    businessIds: new Set(ids)
  };
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

/** Read the rollout gate. Never throws; any failure reads as disabled. */
export async function readAmdResolutionConfig(
  supabase: SettingsSupabase
): Promise<AmdResolutionConfig> {
  try {
    const { data, error } = await supabase
      .from("admin_platform_settings")
      .select("value")
      .eq("key", AMD_RESOLUTION_SETTINGS_KEY)
      .maybeSingle();
    if (error) {
      console.error("amd-resolution: settings read failed", error.message);
      return DISABLED;
    }
    return parseAmdResolutionConfig((data as { value?: unknown } | null)?.value ?? null);
  } catch (err) {
    console.error("amd-resolution: settings read threw", err);
    return DISABLED;
  }
}

export type AmdResolutionDecision =
  /** Machine confirmed, script configured, resolution overdue: speak it. */
  | { action: "speak"; script: string }
  /** Machine confirmed, no script: end the leg (the pre-voicemail behavior). */
  | { action: "hangup" }
  | {
      action: "skip";
      reason:
        | "business_not_enrolled"
        | "not_machine"
        | "screening"
        | "already_resolved"
        | "no_stamp_time"
        | "too_fresh"
        | "too_old";
    };

/**
 * Decide what the sweep should do with one candidate session.
 *
 * `context` is the session's jsonb context as stored; every read is
 * defensive because the column is written by several concurrent handlers.
 */
export function decideAmdResolution(opts: {
  businessId: string;
  context: Record<string, unknown>;
  config: AmdResolutionConfig;
  nowMs: number;
}): AmdResolutionDecision {
  const { businessId, context, config, nowMs } = opts;
  if (!config.enabled || (!config.allBusinesses && !config.businessIds.has(businessId))) {
    return { action: "skip", reason: "business_not_enrolled" };
  }
  if (context.machine_detected !== true) return { action: "skip", reason: "not_machine" };
  // A live person is deciding whether to pick up. The screening event also
  // clears machine_detected, so this only fires in the race window between
  // the two writes; skipping is free and cutting a screened call is not.
  if (context.ios_screening === true) return { action: "skip", reason: "screening" };
  // Someone already owns the voicemail (greeting handler, the model's
  // voicemail_reached, or a previous sweep tick), or a speak is in flight.
  if (context.voicemail_claimed === true || typeof context.voicemail_speak_started_at === "string") {
    return { action: "skip", reason: "already_resolved" };
  }
  const stamped = Date.parse(
    typeof context.machine_stamped_at === "string" ? context.machine_stamped_at : ""
  );
  // Verdicts stamped before this sweep shipped carry no timestamp. Their
  // calls are also long over by the time the sweep could see them; skipping
  // is the only honest option.
  if (!Number.isFinite(stamped)) return { action: "skip", reason: "no_stamp_time" };
  const age = nowMs - stamped;
  if (age < AMD_RESOLUTION_GRACE_MS) return { action: "skip", reason: "too_fresh" };
  if (age > AMD_RESOLUTION_MAX_AGE_MS) return { action: "skip", reason: "too_old" };

  const vm = context.voicemail as { script?: unknown } | undefined;
  const script = typeof vm?.script === "string" ? vm.script.trim() : "";
  return script ? { action: "speak", script } : { action: "hangup" };
}
