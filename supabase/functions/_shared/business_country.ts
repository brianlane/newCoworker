/**
 * Default phone country for a business, edge copy.
 *
 * Decides how BARE (unprefixed) phone digits in a tenant's lead text are
 * read: "US" keeps the historical NANP treatment (the US and Canada share
 * the +1 plan, so both map here), "MX" makes a 10-digit national number
 * read as +52. The rule mirrors the country resolution the dashboard /
 * provisioning side uses (src/lib/plans/business-country.ts): the owner's
 * phone is authoritative when it carries a country, the business timezone
 * is the fallback, and anything inconclusive stays "US" so existing
 * tenants' behavior is byte-identical.
 *
 * Kept as a lockstep copy because edge functions cannot import src/
 * modules (same precedent as normalize_e164.ts); a fixture test asserts
 * the two modules agree.
 */

import { normalizeNanpToE164, type PhoneCountry } from "./ai_flows/engine.ts";

/**
 * IANA zones whose canonical location is Mexico, including the pre-2010
 * aliases some browsers still emit (Santa_Isabel, Ensenada). A stale entry
 * only ever fails toward "US", the do-nothing default.
 */
export const MEXICAN_TIMEZONES: ReadonlySet<string> = new Set([
  "America/Mexico_City",
  "America/Cancun",
  "America/Merida",
  "America/Monterrey",
  "America/Matamoros",
  "America/Chihuahua",
  "America/Ciudad_Juarez",
  "America/Ojinaga",
  "America/Hermosillo",
  "America/Mazatlan",
  "America/Bahia_Banderas",
  "America/Tijuana",
  "America/Santa_Isabel",
  "America/Ensenada"
]);

/**
 * The country whose national plan this business's bare phone digits are
 * interpreted under: +52 owner phone wins, a NANP owner phone pins "US"
 * (never falling through to timezone, matching isCanadianBusiness's
 * phone-authoritative precedence), then a Mexican timezone says "MX".
 */
export function businessDefaultPhoneCountry(input: {
  phone?: string | null;
  timezone?: string | null;
}): PhoneCountry {
  const cleaned = (input.phone ?? "").trim().replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+52")) return "MX";
  if (cleaned && normalizeNanpToE164(cleaned)) return "US";
  const tz = (input.timezone ?? "").trim();
  return MEXICAN_TIMEZONES.has(tz) ? "MX" : "US";
}
