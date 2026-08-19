/**
 * Business country resolution (US / CA / MX), shared by billing and
 * provisioning.
 *
 * There is deliberately NO businesses.country column: the checkout route's
 * draft-phone reconciliation exists so fee detection and provisioning
 * classify from the SAME {phone, timezone} pair, and a stored column would
 * be a third source of truth the Stripe-cancel retry path can leave stale.
 * Classification is always live, from data collected at signup.
 *
 * Precedence, documented and pinned by tests:
 *   1. A +52 phone (or a plus-less 52/521-prefixed 12/13-digit row from
 *      legacy hand entry) is authoritative: MX.
 *   2. A valid NANP phone never falls through to timezone (matching the
 *      original isCanadianBusiness semantics): CA when its NPA is Canadian,
 *      else US.
 *   3. Timezone fallback: Canadian zone => CA, Mexican zone => MX.
 *   4. Anything inconclusive => US, the do-nothing default.
 *
 * The Canadian sets live here (moved from canadian-messaging.ts, which
 * re-exports them) so this module stays the single home of country data.
 * supabase/functions/_shared/business_country.ts is the edge lockstep copy
 * of the US/MX collapse of this rule (edge functions cannot import src/);
 * tests/business-country.test.ts asserts the two agree on a fixture matrix.
 *
 * Pure module (no server imports) so client components (the onboarding
 * order summary) can run the same detection the checkout route bills from.
 */

export type BusinessCountry = "US" | "CA" | "MX";

/**
 * Canadian NANP area codes (NPA). Source: CNAC assignments. Overlays are
 * added rarely; extending this list is a one-line change and a stale entry
 * only ever mislabels a brand-new overlay's tenants as non-Canadian (fee
 * skipped, fails toward not charging).
 */
export const CANADIAN_AREA_CODES: ReadonlySet<string> = new Set([
  "204", "226", "236", "249", "250", "257", "263", "289",
  "306", "343", "354", "365", "367", "368", "382", "387",
  "403", "416", "418", "428", "431", "437", "438", "450",
  "460", "468", "474",
  "506", "514", "519", "548", "579", "581", "584", "587",
  "604", "613", "639", "647", "672", "683",
  "705", "709", "742", "753", "778", "780", "782",
  "807", "819", "825", "867", "873", "879",
  "902", "905"
]);

/** IANA zones whose canonical location is in Canada. */
export const CANADIAN_TIMEZONES: ReadonlySet<string> = new Set([
  "America/St_Johns",
  "America/Halifax",
  "America/Glace_Bay",
  "America/Moncton",
  "America/Goose_Bay",
  "America/Blanc-Sablon",
  "America/Toronto",
  "America/Montreal",
  "America/Nipigon",
  "America/Thunder_Bay",
  "America/Iqaluit",
  "America/Pangnirtung",
  "America/Atikokan",
  "America/Winnipeg",
  "America/Rainy_River",
  "America/Resolute",
  "America/Rankin_Inlet",
  "America/Regina",
  "America/Swift_Current",
  "America/Edmonton",
  "America/Cambridge_Bay",
  "America/Yellowknife",
  "America/Inuvik",
  "America/Creston",
  "America/Dawson_Creek",
  "America/Fort_Nelson",
  "America/Whitehorse",
  "America/Dawson",
  "America/Vancouver"
]);

/**
 * IANA zones whose canonical location is Mexico, including the pre-2010
 * aliases some browsers still emit (Santa_Isabel, Ensenada). Keep in
 * lockstep with the edge copy (supabase/functions/_shared/
 * business_country.ts); the fixture test compares the two sets. A stale
 * entry only ever fails toward "US", the do-nothing default.
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
 * NANP area code (NPA) from a free-form phone string, or null. Moved from
 * canadian-messaging.ts (which re-exports it as canadianNpaFromPhone);
 * mirrors extractNanpAreaCode in src/lib/telnyx/assign-did.ts, kept
 * separate deliberately because that module drags in server-only Supabase
 * imports and this one must stay client-bundle-safe.
 */
export function nanpNpaFromPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  let candidate: string;
  if (cleaned.startsWith("+")) candidate = cleaned;
  else if (cleaned.length === 10) candidate = `+1${cleaned}`;
  else if (cleaned.length === 11 && cleaned.startsWith("1")) candidate = `+${cleaned}`;
  else return null;
  const match = /^\+1(\d{10})$/.exec(candidate);
  if (!match) return null;
  const npa = match[1].slice(0, 3);
  return /^[2-9]\d{2}$/.test(npa) ? npa : null;
}

/**
 * Is this a Mexican-shaped phone: +52-prefixed, or a plus-less 52/521
 * 12/13-digit run (legacy hand entry) whose national number is valid (10
 * digits, not 0/1-leading)? Gated on those lengths so a bare 10-digit
 * value can never read as Mexican from the phone alone.
 */
function isMxShapedPhone(cleaned: string): boolean {
  const digits = cleaned.replace(/[^\d]/g, "");
  const national = cleaned.startsWith("+52")
    ? digits.length === 12
      ? digits.slice(2)
      : digits.length === 13 && digits.startsWith("521")
        ? digits.slice(3)
        : null
    : !cleaned.startsWith("+") &&
        ((digits.length === 12 && digits.startsWith("52")) ||
          (digits.length === 13 && digits.startsWith("521")))
      ? digits.slice(digits.length - 10)
      : null;
  return national !== null && national[0] !== "0" && national[0] !== "1";
}

/**
 * Normalize a Mexican phone to E.164 (+52 + 10 national digits), or null.
 * Accepts +52/52/521-prefixed 12-13 digit shapes; the bare-10 arm applies
 * only to plus-less input (a `+` means the digits carry a country code).
 * 0/1-leading nationals are never real. Client-bundle-safe mirror of the
 * edge engine's normalizeMxToE164 (edge functions cannot import src/).
 */
export function normalizeMxPhoneToE164(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^\d]/g, "");
  const national =
    digits.length === 12 && digits.startsWith("52")
      ? digits.slice(2)
      : digits.length === 13 && digits.startsWith("521")
        ? digits.slice(3)
        : !trimmed.replace(/[^\d+]/g, "").startsWith("+") && digits.length === 10
          ? digits
          : null;
  if (!national) return null;
  if (national[0] === "0" || national[0] === "1") return null;
  return `+52${national}`;
}

/**
 * Compose the owner phone the questionnaire submits from the country-prefix
 * selector + the raw field value. A typed `+` always wins over the selector
 * (the owner stated their own country code). Under "+52", national digits
 * compose to a full +52 E.164 so the draft, the order-summary preview,
 * /api/business/create, and /api/checkout all see the identical value (the
 * reconciliation invariant). Under "+1" the raw value is returned for the
 * existing NANP coercion to handle. Null means the value cannot be a valid
 * number under the selected prefix.
 */
export function composeOwnerPhone(prefix: "+1" | "+52", raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.replace(/[^\d+]/g, "").startsWith("+")) return trimmed;
  if (prefix === "+52") return normalizeMxPhoneToE164(trimmed);
  return trimmed;
}

/**
 * Resolve the business country from the owner phone + business timezone,
 * the same signals isCanadianBusiness always used. Billing (the fee), the
 * messaging-profile pick, and the DID search country must all classify
 * from the same values; callers are responsible for passing the same
 * {phone, timezone} pair everywhere (see the checkout route's draft-phone
 * reconciliation).
 */
export function resolveBusinessCountry(input: {
  phone?: string | null;
  timezone?: string | null;
}): BusinessCountry {
  const cleaned = (input.phone ?? "").trim().replace(/[^\d+]/g, "");
  if (cleaned && isMxShapedPhone(cleaned)) return "MX";
  const npa = nanpNpaFromPhone(cleaned);
  if (npa) return CANADIAN_AREA_CODES.has(npa) ? "CA" : "US";
  const tz = (input.timezone ?? "").trim();
  if (CANADIAN_TIMEZONES.has(tz)) return "CA";
  if (MEXICAN_TIMEZONES.has(tz)) return "MX";
  return "US";
}
