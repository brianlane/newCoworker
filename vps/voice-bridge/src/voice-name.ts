/**
 * Which Gemini Live voice a call answers in.
 *
 * Voice-bridge-local mirror of the allow-list and platform default in
 * src/lib/plans/enterprise-models.ts (the bridge is rsynced to the VPS
 * standalone and cannot import from the app);
 * tests/voice-name-lockstep.test.ts pins the two lists and the default equal.
 *
 * Resolution order, most specific first:
 *   1. the tenant's `business_telnyx_settings.voice_name` (set from admin,
 *      read per call, so a change applies to the NEXT call with no redeploy);
 *   2. the box's `VOICE_NAME` env (what provisioning used to write; kept as an
 *      ops escape hatch for a single box);
 *   3. `DEFAULT_VOICE_NAME`.
 *
 * Sending nothing is deliberately NOT an option anymore. An unset voice meant
 * taking Gemini's per-model default, which is undocumented, differs between
 * models, and which Google warns can change: two boxes with identical config
 * were observed answering in different voices. A caller hearing a different
 * person from one week to the next is a brand defect, so we always ask.
 */
export const GEMINI_LIVE_VOICES = [
  "Achernar",
  "Achird",
  "Algenib",
  "Algieba",
  "Alnilam",
  "Aoede",
  "Autonoe",
  "Callirrhoe",
  "Charon",
  "Despina",
  "Enceladus",
  "Erinome",
  "Fenrir",
  "Gacrux",
  "Iapetus",
  "Kore",
  "Laomedeia",
  "Leda",
  "Orus",
  "Puck",
  "Pulcherrima",
  "Rasalgethi",
  "Sadachbia",
  "Sadaltager",
  "Schedar",
  "Sulafat",
  "Umbriel",
  "Vindemiatrix",
  "Zephyr",
  "Zubenelgenubi"
] as const;

export type GeminiLiveVoice = (typeof GEMINI_LIVE_VOICES)[number];

/** Platform default. Lockstep with DEFAULT_GEMINI_LIVE_VOICE in the app. */
export const DEFAULT_VOICE_NAME: GeminiLiveVoice = "Kore";

/** Narrow an arbitrary value to a supported voice, else null. */
export function normalizeVoiceName(value: unknown): GeminiLiveVoice | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return (GEMINI_LIVE_VOICES as readonly string[]).includes(trimmed)
    ? (trimmed as GeminiLiveVoice)
    : null;
}

export function resolveVoiceName(input: {
  /** business_telnyx_settings.voice_name for this tenant. */
  tenantVoiceName?: unknown;
  /** VOICE_NAME from the box env. */
  envVoiceName?: unknown;
}): GeminiLiveVoice {
  return (
    normalizeVoiceName(input.tenantVoiceName) ??
    normalizeVoiceName(input.envVoiceName) ??
    DEFAULT_VOICE_NAME
  );
}
