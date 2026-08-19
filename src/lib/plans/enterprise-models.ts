/**
 * Designated reasoning models + voice picker (enterprise), schema for
 * `businesses.enterprise_models` (migration 20260810000000).
 *
 * Same override pattern as enterprise-limits: nullable jsonb on the
 * business, strict zod at every boundary, omitted keys = platform defaults.
 * Values become deploy env (`OWNER_CHAT_MODEL`, `SMS_CHAT_MODEL`,
 * `GEMINI_LIVE_MODEL`) at the next provision/redeploy of the tenant box, so
 * changes are NOT live-applied, the admin UI says so.
 *
 * The VOICE is no longer one of them: it moved to
 * `business_telnyx_settings.voice_name`, read per call by the bridge, so owners
 * on any tier can audition voices without a redeploy. The voice allow-list and
 * platform default still live in this module because it is where the Gemini
 * Live vocabulary belongs.
 *
 * Validation is shape-based rather than a hardcoded model catalog (Google
 * ships new model ids monthly; an allow-list here would rot):
 *  - chat models must be `gemini-*` and NOT live-flavored (the llm-router
 *    meters non-live gemini models through the shared AI budget; a live
 *    model in a chat slot would bypass that metering, see
 *    vps/llm-router/src/routing.js).
 *  - the voice model must be `gemini-*live*` (audio-to-audio).
 *  - the voice NAME is a fixed allow-list: Gemini Live's prebuilt voices.
 */

import { z } from "zod";

/**
 * Gemini Live's prebuilt voices, alphabetical. This is the single allow-list
 * behind the zod enum below, the `business_telnyx_settings.voice_name` CHECK
 * constraint, and the admin dropdown; tests/voice-name-lockstep.test.ts pins
 * them equal so widening this set cannot half-land.
 *
 * Was an 8-voice subset until Jul 2026. Widened to Google's full published set
 * so an owner auditioning a voice is not limited to the handful someone picked
 * years earlier: the warmer and gentler options (Sulafat, Vindemiatrix) suit
 * some businesses far better than the original list allowed.
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

/**
 * Google's one-word character description per voice, shown in the admin
 * dropdown. Auditioning 30 names with no hint of how they sound is worse than
 * having 8, so the label is what makes the wider list usable.
 */
export const GEMINI_LIVE_VOICE_LABELS: Record<GeminiLiveVoice, string> = {
  Achernar: "Soft",
  Achird: "Friendly",
  Algenib: "Gravelly",
  Algieba: "Smooth",
  Alnilam: "Firm",
  Aoede: "Breezy",
  Autonoe: "Bright",
  Callirrhoe: "Easy-going",
  Charon: "Informative",
  Despina: "Smooth",
  Enceladus: "Breathy",
  Erinome: "Clear",
  Fenrir: "Excitable",
  Gacrux: "Mature",
  Iapetus: "Clear",
  Kore: "Firm",
  Laomedeia: "Upbeat",
  Leda: "Youthful",
  Orus: "Firm",
  Puck: "Upbeat",
  Pulcherrima: "Forward",
  Rasalgethi: "Informative",
  Sadachbia: "Lively",
  Sadaltager: "Knowledgeable",
  Schedar: "Even",
  Sulafat: "Warm",
  Umbriel: "Easy-going",
  Vindemiatrix: "Gentle",
  Zephyr: "Bright",
  Zubenelgenubi: "Casual"
};

/**
 * The voice every tenant gets unless they pick another one.
 *
 * Leaving it unset meant taking Gemini's undocumented per-model default, which
 * Google warns can change and which was observed differing between two boxes
 * with identical config. Pinning it makes the voice a deliberate choice and a
 * stable one.
 */
export const DEFAULT_GEMINI_LIVE_VOICE: GeminiLiveVoice = "Kore";

/** Narrow an arbitrary stored value to a supported voice, else null. */
export function normalizeGeminiLiveVoice(value: unknown): GeminiLiveVoice | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return (GEMINI_LIVE_VOICES as readonly string[]).includes(trimmed)
    ? (trimmed as GeminiLiveVoice)
    : null;
}

const MODEL_ID_MAX = 64;
/** Lowercase gemini model id, e.g. gemini-3.1-flash or gemini-2.5-flash-lite. */
const GEMINI_MODEL_RE = /^gemini-[a-z0-9][a-z0-9.-]*$/;

const chatModel = z
  .string()
  .trim()
  .max(MODEL_ID_MAX)
  .regex(GEMINI_MODEL_RE, "Must be a gemini-* model id")
  .refine((m) => !m.includes("live"), {
    message: "Chat slots need a non-live Gemini model (live models bypass AI-budget metering)"
  });

const liveModel = z
  .string()
  .trim()
  .max(MODEL_ID_MAX)
  .regex(GEMINI_MODEL_RE, "Must be a gemini-* model id")
  .refine((m) => m.includes("live"), {
    message: "Voice needs a live-flavored Gemini model (audio-to-audio)"
  })
  // `gemini-3.5-live-translate-preview` satisfies the live check above but
  // supports NO function calling and NO system instructions, so putting it in
  // the receptionist slot silently strips every tool and the entire persona:
  // no booking, no knowledge lookup, no identity. It is a translation engine,
  // not an agent. If we ever use it, it gets its own session for the
  // interpreted stretch, never this slot.
  .refine((m) => !m.includes("translate"), {
    message:
      "Translate-flavored live models support no tools or instructions, so they cannot run the phone coworker"
  });

export const enterpriseModelsSchema = z
  .object({
    /** Rowboat OwnerCoworker (owner dashboard chat). */
    ownerChatModel: chatModel,
    /** Rowboat Coworker (inbound customer SMS). */
    smsChatModel: chatModel,
    /** Gemini Live realtime voice model. */
    geminiLiveModel: liveModel
    // `voiceName` deliberately does NOT live here anymore. It moved to
    // `business_telnyx_settings.voice_name` (migration 20260821007000): the
    // voice is a cosmetic choice every tier should be able to make and audition
    // live, whereas this blob is enterprise-only and applies only at the next
    // box redeploy. Keeping a second home for it would just invite drift.
  })
  .partial();

export type EnterpriseModels = z.infer<typeof enterpriseModelsSchema>;

/** Lenient read-side parse: garbage in the column means platform defaults. */
export function parseEnterpriseModels(raw: unknown): EnterpriseModels | null {
  if (raw == null) return null;
  const result = enterpriseModelsSchema.safeParse(raw);
  if (!result.success) return null;
  return Object.keys(result.data).length > 0 ? result.data : null;
}
