/**
 * Which languages should Gemini Live expect to HEAR on this call?
 *
 * The bridge used to send `inputAudioTranscription: {}`, empty, no hint at
 * all, which leaves the Live API auto-detecting across every language it
 * knows. On a noisy segment it guesses, and the guess lands in the transcript
 * as fact. Chris Bartelot's Aug 3 2026 call is the example: a caller speaking
 * English throughout, with turn 30 transcribed as Portuguese ("Você dizia Qual
 * dos O outro lugar é o quê?") and turn 38 as Korean ("뭐가").
 *
 * The fix is `languageHints`, not a hard pin. Two reasons it must not be a
 * hard pin to English:
 *
 *   - This platform serves Spanish callers. `customer-language-line.ts`
 *     supports en and es, contacts carry `preferred_language`, and tenants
 *     carry `businesses.default_customer_language`. Pinning en would silently
 *     wreck transcription for every Spanish caller.
 *   - `languageHints` accepts MORE THAN ONE code, so narrowing to the set the
 *     tenant actually serves already removes the entire long tail that
 *     produced Portuguese and Korean, without forcing a choice between them.
 *
 * Ordering matters as a preference signal, so the language we have the most
 * evidence for goes first: the caller's established preference, then the
 * tenant's default, then the rest of what the platform supports.
 *
 * NOTE for the SDK: `languageHints` and `languageAuto` are mutually exclusive
 * ("Do not use together"), so setting hints means NOT setting languageAuto.
 * `languageCodes` directly on AudioTranscriptionConfig is deprecated in favor
 * of these two.
 */
import type { VoiceCustomerLanguage } from "./customer-language-line.js";

/**
 * BCP-47 tags for the languages the platform supports. Regional variants are
 * deliberate: bare "es" leaves the recognizer to pick a variant, and the
 * caller base for this product is US and Mexico.
 */
const BCP47_BY_LANGUAGE: Record<VoiceCustomerLanguage, string> = {
  en: "en-US",
  es: "es-US"
};

/** Every language the platform supports, in fallback order. */
const ALL_SUPPORTED: VoiceCustomerLanguage[] = ["en", "es"];

export type AsrLanguagePrefs = {
  /** `contacts.preferred_language` for this caller, when known. */
  established?: VoiceCustomerLanguage | null;
  /** `businesses.default_customer_language`. */
  defaultLang?: VoiceCustomerLanguage;
};

/**
 * BCP-47 codes to hint, most-likely first. Never empty: with no preferences at
 * all this still returns the full supported set, which is the point, a
 * bounded list beats unbounded auto-detection even when we know nothing about
 * the caller.
 */
export function asrLanguageHintCodes(prefs: AsrLanguagePrefs = {}): string[] {
  const ordered: VoiceCustomerLanguage[] = [];
  const push = (lang: VoiceCustomerLanguage | null | undefined) => {
    if (lang && BCP47_BY_LANGUAGE[lang] && !ordered.includes(lang)) ordered.push(lang);
  };
  push(prefs.established);
  push(prefs.defaultLang);
  for (const lang of ALL_SUPPORTED) push(lang);
  return ordered.map((lang) => BCP47_BY_LANGUAGE[lang]);
}

/**
 * The `inputAudioTranscription` value for `ai.live.connect`. Shaped as its own
 * function so the call site stays a spread and the "never send an empty
 * object" rule lives with the reasoning above.
 */
export function inputAudioTranscriptionConfig(
  prefs: AsrLanguagePrefs = {}
): { languageHints: { languageCodes: string[] } } {
  return { languageHints: { languageCodes: asrLanguageHintCodes(prefs) } };
}
