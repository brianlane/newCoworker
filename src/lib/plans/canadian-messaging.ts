/**
 * Canadian messaging surcharge — detection + fee constants.
 *
 * Canadian carriers charge per-message pass-through surcharges (~$0.004–0.010
 * USD/part) that US traffic doesn't, and Canadian tenants' numbers must ride
 * a messaging profile whose whitelisted destinations include CA. New signups
 * detected as Canadian pay a flat, clearly-labeled monthly surcharge that
 * offsets those carrier costs; it rides the Stripe subscription as its own
 * recurring line item (billed at the plan's cadence — upfront × months on
 * term plans, like the plan itself).
 *
 * Detection is deterministic from data we already collect at signup: the
 * owner's phone area code (the same signal that biases their coworker number
 * search local to them) against the Canadian NANP set, with the browser
 * timezone as the fallback when the phone isn't a NANP number.
 *
 * Existing tenants are grandfathered by construction: the fee is only added
 * by the NEW-SIGNUP checkout, never retrofitted onto live subscriptions.
 *
 * Pure module (no server imports) so the onboarding order summary — a client
 * component — can run the same detection the checkout route bills from.
 */

/** Flat monthly surcharge, all tiers ($4.99/mo). */
export const CANADA_MESSAGING_FEE_MONTHLY_CENTS = 499;

/**
 * Product name on the Stripe line item — the customer-visible label on
 * checkout, invoices, and the billing portal. Also the sentinel other code
 * can use to find the fee line on an invoice (same pattern as
 * CARRIER_REGISTRATION_FEE_NAME).
 */
export const CANADA_MESSAGING_FEE_NAME = "Canadian messaging surcharge";

/**
 * Canadian NANP area codes (NPA). Source: CNAC assignments. Overlays are
 * added rarely; extending this list is a one-line change and a stale entry
 * only ever mislabels a brand-new overlay's tenants as non-Canadian (fee
 * skipped — fails toward not charging).
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
 * NANP area code (NPA) from a free-form onboarding phone string, or null.
 * Mirrors `extractNanpAreaCode` in src/lib/telnyx/assign-did.ts (kept
 * separate deliberately: that module drags in server-only Supabase imports,
 * and this one must stay client-bundle-safe for the order summary).
 */
export function canadianNpaFromPhone(raw: string | null | undefined): string | null {
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
 * True when the signup looks Canadian: the owner phone's NANP area code is a
 * Canadian NPA (authoritative — it also drives which country their coworker
 * number is purchased in), else the browser timezone recorded at onboarding.
 * Both signals absent/inconclusive ⇒ not Canadian (fee skipped, US profile).
 */
export function isCanadianBusiness(input: {
  phone?: string | null;
  timezone?: string | null;
}): boolean {
  const npa = canadianNpaFromPhone(input.phone);
  if (npa) return CANADIAN_AREA_CODES.has(npa);
  const tz = (input.timezone ?? "").trim();
  return tz.length > 0 && CANADIAN_TIMEZONES.has(tz);
}
