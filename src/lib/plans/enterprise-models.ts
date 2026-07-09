/**
 * Designated reasoning models + voice picker (enterprise) — schema for
 * `businesses.enterprise_models` (migration 20260810000000).
 *
 * Same override pattern as enterprise-limits: nullable jsonb on the
 * business, strict zod at every boundary, omitted keys = platform defaults.
 * Values become deploy env (`OWNER_CHAT_MODEL`, `SMS_CHAT_MODEL`,
 * `GEMINI_LIVE_MODEL`, `VOICE_NAME`) at the next provision/redeploy of the
 * tenant box, so changes are NOT live-applied — the admin UI says so.
 *
 * Validation is shape-based rather than a hardcoded model catalog (Google
 * ships new model ids monthly; an allow-list here would rot):
 *  - chat models must be `gemini-*` and NOT live-flavored (the llm-router
 *    meters non-live gemini models through the shared AI budget; a live
 *    model in a chat slot would bypass that metering — see
 *    vps/llm-router/src/routing.js).
 *  - the voice model must be `gemini-*live*` (audio-to-audio).
 *  - the voice NAME is a fixed allow-list: Gemini Live's prebuilt voices.
 */

import { z } from "zod";

/** Gemini Live prebuilt voices (professional voice picker options). */
export const GEMINI_LIVE_VOICES = [
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Zephyr"
] as const;
export type GeminiLiveVoice = (typeof GEMINI_LIVE_VOICES)[number];

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
  });

export const enterpriseModelsSchema = z
  .object({
    /** Rowboat OwnerCoworker (owner dashboard chat). */
    ownerChatModel: chatModel,
    /** Rowboat Coworker (inbound customer SMS). */
    smsChatModel: chatModel,
    /** Gemini Live realtime voice model. */
    geminiLiveModel: liveModel,
    /** Prebuilt Gemini Live voice callers hear. */
    voiceName: z.enum(GEMINI_LIVE_VOICES)
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
