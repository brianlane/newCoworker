/**
 * Resolve the language a voice call should run in.
 *
 * Voice was the last channel reading no stored preference at all: the bridge
 * hardcoded English while the texting coworker, Messenger, WhatsApp, and even
 * the speak-only IVR paths in `telnyx-voice-inbound` all honored the same two
 * columns. A tenant whose customers are Spanish-speaking therefore got an
 * English greeting on every call, and a known Spanish contact was answered in
 * English until they spoke enough Spanish for the model to switch.
 *
 * Precedence mirrors the other channels (see src/lib/db/contact-language.ts):
 *   1. the contact's own `contacts.preferred_language` (an owner override from
 *      the contact Language dropdown is authoritative and lands in this same
 *      column, so it wins here too),
 *   2. the tenant's `businesses.default_customer_language`,
 *   3. English.
 *
 * Kept dependency-free in its own module so repo-root tests and typecheck can
 * import it without the bridge's VPS-only runtime deps.
 */
import type { VoiceCustomerLanguage } from "./customer-language-line.js";

export type ResolvedVoiceLanguage = {
  /** The caller's known language, when we have one. Drives the prompt's "current conversation language". */
  established: VoiceCustomerLanguage | null;
  /** What to fall back to when the caller's language is unclear. */
  defaultLang: VoiceCustomerLanguage;
};

/** Narrow an arbitrary DB value to a supported language, else null. */
export function normalizeVoiceLanguage(value: unknown): VoiceCustomerLanguage | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "es") return "es";
  if (v === "en") return "en";
  return null;
}

export function resolveVoiceLanguagePrefs(input: {
  /** contacts.preferred_language for the caller, when the number is known. */
  contactPreferredLanguage?: unknown;
  /** businesses.default_customer_language for the tenant. */
  businessDefaultLanguage?: unknown;
}): ResolvedVoiceLanguage {
  const businessDefault = normalizeVoiceLanguage(input.businessDefaultLanguage) ?? "en";
  const contact = normalizeVoiceLanguage(input.contactPreferredLanguage);
  return {
    // A contact language that merely repeats the tenant default is still worth
    // carrying: the prompt only renders the "current conversation language"
    // clause when it DIFFERS from the default, so this stays a no-op there.
    established: contact,
    defaultLang: businessDefault
  };
}
