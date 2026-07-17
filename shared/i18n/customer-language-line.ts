import type { CustomerLanguage } from "./detect-customer-language.ts";
import { shouldSkipCustomerLanguagePrompt } from "./detect-customer-language.ts";

export function customerLanguageLine(opts: {
  detected?: CustomerLanguage | null;
  established?: CustomerLanguage | null;
  defaultLang?: CustomerLanguage;
  supported?: CustomerLanguage[];
}): string {
  const defaultLang = opts.defaultLang ?? "en";
  const supported = opts.supported ?? ["en", "es"];

  if (shouldSkipCustomerLanguagePrompt(supported)) {
    return "";
  }

  const active = opts.established ?? opts.detected ?? defaultLang;
  const langs = supported.join(" and ");

  return (
    `Language: reply in the same language the customer uses (${langs} supported). ` +
    `When they mix languages, follow the language carrying the substance of their message — ` +
    `broken English with a few Spanish words is still English; fluent Spanish with an English greeting is Spanish. ` +
    `If they switch languages mid-conversation with full sentences, follow the switch. ` +
    `Default to ${defaultLang} when unclear.` +
    (active !== defaultLang ? ` Current conversation language: ${active}.` : "")
  );
}
