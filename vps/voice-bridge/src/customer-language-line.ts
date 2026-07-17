/** Voice-bridge-local copy of shared/i18n/customer-language-line.ts (rsynced standalone). */
export function customerLanguageLine(opts: {
  defaultLang?: "en" | "es";
} = {}): string {
  const defaultLang = opts.defaultLang ?? "en";
  return (
    `Language: reply in the same language the customer uses (English and Spanish supported). ` +
    `When they mix languages, follow the language carrying the substance of their message — ` +
    `broken English with a few Spanish words is still English; fluent Spanish with an English greeting is Spanish. ` +
    `If they switch languages mid-conversation with full sentences, follow the switch. ` +
    `Default to ${defaultLang} when unclear.`
  );
}
