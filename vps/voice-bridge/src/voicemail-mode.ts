/**
 * Deterministic voicemail delivery: the decision and the words, kept pure.
 *
 * WHY THE MODEL LOST THE READING JOB. On 2026-08-29 (call 5e325829, Amy
 * Laidlaw) the model did everything the prompts ask: it recognized the
 * mailbox, called `voicemail_reached` BEFORE speaking, and got back the
 * instruction to read the approved message. It then spoke a compressed
 * rewrite carrying an invented "offer came through" claim and a fabricated
 * callback number, and hung up before even its own version could finish
 * playing. (The dropped `script` field, fixed in tool-response-payload.ts,
 * explains that call. It does not restore trust: thirteen fabrications
 * before it, plus two after the #1612 prompt rule, were all the model
 * ad-libbing where no instruction asked it to speak at all.)
 *
 * So on the calls where the stakes are highest, an outbound leg that hit a
 * machine with an author-approved script waiting, the model's mouth is now
 * removed from the delivery path entirely. `voicemail_reached` becomes a
 * pure verdict: the bridge stamps the machine result, MUTES the model's
 * audio for the rest of the call, holds the model's `end_call` so it cannot
 * kill the leg early (today's failure ended the call 9 seconds after the
 * verdict, before any deterministic path could act), and the platform's
 * edge machinery speaks the script itself over Telnyx text-to-speech:
 * `greeting.ended` when Telnyx delivers the beep event, else the AMD
 * resolution sweep 25 seconds after the machine stamp (PR #1674). Both run
 * through the shared `voice_claim_voicemail_speak` claim, both stamp
 * `voicemail_spoken` only on confirmed playout, and a spoken script is then
 * verbatim BY CONSTRUCTION.
 *
 * ROLLOUT GATE. The mode only arms where the sweep backstop is armed, the
 * `voice_amd_resolution` key in admin_platform_settings, because a leg the
 * bridge silences and refuses to end MUST have something coming to speak
 * and hang up. Parsing is a lockstep copy of the edge's
 * `parseAmdResolutionConfig` (supabase/functions/_shared/voice_amd_resolution.ts,
 * pinned by tests/voice-bridge-voicemail-mode.test.ts): anything missing or
 * malformed reads as not enrolled, so the mode fails toward yesterday's
 * behavior, never toward a muted leg nobody resolves.
 */

/** admin_platform_settings key for the AMD resolution sweep rollout gate. */
export const AMD_RESOLUTION_SETTINGS_KEY = "voice_amd_resolution";

/** admin_platform_settings key for the spoken-number firewall rollout gate. */
export const NUMBER_GUARD_SETTINGS_KEY = "voice_spoken_number_guard";

export type RolloutGate = {
  enabled: boolean;
  allBusinesses: boolean;
  businessIds: ReadonlySet<string>;
};

const GATE_DISABLED: RolloutGate = {
  enabled: false,
  allBusinesses: false,
  businessIds: new Set()
};

/**
 * Parse a rollout-gate settings value. Lockstep semantics with the edge's
 * `parseAmdResolutionConfig`: `enabled` must be literally true, business ids
 * must be non-empty strings, and anything malformed disables the gate.
 */
export function parseRolloutGate(raw: unknown): RolloutGate {
  if (typeof raw !== "object" || raw === null) return GATE_DISABLED;
  const value = raw as { enabled?: unknown; all_businesses?: unknown; business_ids?: unknown };
  if (value.enabled !== true) return GATE_DISABLED;
  const ids = Array.isArray(value.business_ids)
    ? value.business_ids.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
  return {
    enabled: true,
    allBusinesses: value.all_businesses === true,
    businessIds: new Set(ids)
  };
}

/** Whether a business is enrolled in a parsed rollout gate. */
export function rolloutIncludes(gate: RolloutGate, businessId: string): boolean {
  return gate.enabled && (gate.allBusinesses || gate.businessIds.has(businessId));
}

/**
 * Whether this session runs deterministic voicemail delivery.
 *
 * All three conditions are load-bearing:
 *  - outbound: the resolution sweep only queries outbound AI legs, and an
 *    inbound gated transfer has no authored script on its session context,
 *    so the sweep would HANG UP a live-transfer leg as scriptless.
 *  - an authored script: a scriptless leg's correct deterministic outcome is
 *    the existing one (say nothing, end the call), which needs no mute.
 *  - enrollment: without the sweep armed, nothing would ever speak or end a
 *    leg the bridge muted and refused to end.
 */
export function deterministicVoicemailArmed(opts: {
  direction: "inbound" | "outbound";
  voicemailScript: string;
  amdResolutionEnrolled: boolean;
}): boolean {
  return (
    opts.direction === "outbound" &&
    opts.voicemailScript.trim() !== "" &&
    opts.amdResolutionEnrolled
  );
}

/**
 * Tool reply when the verdict is accepted and the platform takes over
 * delivery. The model's audio is muted from this moment, so the words only
 * matter for keeping it calm and stopping the end_call attempts.
 */
export const VOICEMAIL_DETERMINISTIC_TOOL_REPLY =
  "recording confirmed. The platform is leaving the approved message itself over this line. " +
  "Say nothing more for the rest of this call, and do NOT call end_call: the call ends " +
  "automatically once the message has played.";

/** Reply given to an `end_call` attempt while the platform still owes the voicemail. */
export const VOICEMAIL_DETERMINISTIC_END_CALL_REPLY =
  "not yet: the platform is still leaving the approved voicemail on this line. Say nothing " +
  "and do not call end_call again; the call ends automatically once the message has played.";

/**
 * How long the model's `end_call` is refused after the deterministic verdict.
 *
 * Long enough for the slowest legitimate resolution: the sweep runs on a 15s
 * cadence and acts 25s after the machine stamp, then the spoken script needs
 * its playout (the longest authored script today reads in well under 30s).
 * Short enough that a broken resolver cannot pin the leg: past this window
 * the model may end the call again, and the mailbox's own recording limit
 * (60-180s) bounds the leg regardless.
 */
export const VOICEMAIL_END_CALL_HOLD_MS = 120_000;

/**
 * How often the bridge re-reads the session while the deterministic hold is
 * pending. The poll is the LIFT for a verdict that turns out wrong: Apple
 * call screening clears the machine stamp edge-side, and the sweep then
 * deliberately never speaks, so without this poll a screened call that a
 * real person answers would sit against a muted model until the hold
 * expires (Bugbot, PR #1742). Light: one indexed select, only on legs in
 * the deterministic-pending state, bounded by the hold window.
 */
export const VOICEMAIL_RESOLUTION_POLL_MS = 3_000;

/**
 * What the deterministic hold's poll can learn about the leg.
 *
 *  - "pending": still an unresolved machine verdict; keep the mute and hold.
 *  - "live": the verdict was withdrawn (screening event cleared it, or the
 *    stamp is gone): a real person may be on the line. Lift the mute, lift
 *    the hold, and cue the model back into the conversation.
 *  - "speaking": the edge holds the voicemail claim and its TTS is playing
 *    or about to. Stop polling; the mute stays (chatter over the script is
 *    the double-speak the claim exists to prevent) and `call.speak.ended`
 *    ends the leg.
 */
export type VoicemailResolutionState = "pending" | "live" | "speaking";

/**
 * Cue sent when the hold lifts because the leg turned out to be live. Must
 * explicitly override the earlier "say nothing more for the rest of this
 * call" tool reply, or the model stays silent at a real person.
 */
export const VOICEMAIL_MUTE_LIFTED_CUE =
  "[Coordinator] Disregard the earlier instruction to stay silent: this line is NOT a " +
  "confirmed recording after all (call screening or a live pickup). A real person may be " +
  "on the line. Continue the conversation normally: if they speak, respond; if the line " +
  "is quiet, greet them once with your opening line. End with the end_call tool when the " +
  "conversation is genuinely over.";
