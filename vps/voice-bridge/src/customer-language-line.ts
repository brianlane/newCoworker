/**
 * Voice-bridge-local copy of shared/i18n/customer-language-line.ts (rsynced
 * standalone, so it cannot import across the repo). The RETURNED STRING must
 * stay byte-identical to the shared module for the same inputs;
 * tests/voice-bridge-language-line.test.ts pins the two against each other so
 * a one-sided edit is loud.
 *
 * `shouldSkipCustomerLanguagePrompt` is inlined rather than imported for the
 * same standalone reason.
 */
export type VoiceCustomerLanguage = "en" | "es";

function shouldSkipCustomerLanguagePrompt(supported?: VoiceCustomerLanguage[]): boolean {
  return supported?.length === 1 && supported[0] === "en";
}

export function customerLanguageLine(opts: {
  detected?: VoiceCustomerLanguage | null;
  established?: VoiceCustomerLanguage | null;
  defaultLang?: VoiceCustomerLanguage;
  supported?: VoiceCustomerLanguage[];
} = {}): string {
  const defaultLang = opts.defaultLang ?? "en";
  const supported = opts.supported ?? ["en", "es"];

  if (shouldSkipCustomerLanguagePrompt(supported)) {
    return "";
  }

  const active = opts.established ?? opts.detected ?? defaultLang;
  const langs = supported.join(" and ");

  return (
    `Language: reply in the same language the customer uses (${langs} supported). ` +
    `When they mix languages, follow the language carrying the substance of their message: ` +
    `broken English with a few Spanish words is still English; fluent Spanish with an English greeting is Spanish. ` +
    `If they switch languages mid-conversation with full sentences, follow the switch. ` +
    `Default to ${defaultLang} when unclear.` +
    (active !== defaultLang ? ` Current conversation language: ${active}.` : "")
  );
}
