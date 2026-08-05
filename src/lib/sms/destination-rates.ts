/**
 * Destination-country resolution and cost multipliers for outbound SMS.
 *
 * The monthly cap charges text units denominated in the blended US per-part
 * cost ($0.008787, measured Aug 2026). International destinations that cost
 * more multiply a send's units so a Danish message that costs ~18x simply
 * consumes ~18x the allowance: every country is supported with no separate
 * caps and no allowlist. Multipliers derive from the account rate deck
 * (https://telnyx.com/pricing.md, per-country long-code termination sell
 * price / $0.008787, rounded to one decimal, min 1). Of 217 deck countries,
 * 196 sit at the $0.004 floor and multiply by 1.
 *
 * Billing-basis caveat: most deck rows read "per message" while our MX
 * work assumed per PART. Units apply the multiplier per part, the
 * conservative direction (over-counts multi-part international if billing
 * is truly per message); verify against the MDR of the first real
 * international sends and adjust.
 *
 * The dial-code table is the TS mirror of `sms_dial_codes` in the
 * sms_destination_gating migration (longest-prefix match; NANP defaults to
 * US with Caribbean +1XXX overrides). A worker-integration fixture matrix
 * keeps SQL, this file, and the _shared Deno copy in agreement. The
 * denylist mirrors the reserve gate's refusal list; it is enforced in SQL,
 * exported here for display/tests.
 */

/** E.164 prefix (no plus) -> ISO country. Longest prefix wins. */
export const SMS_DIAL_CODES: Record<string, string> = {
  "1": "US",
  "1242": "BS", "1246": "BB", "1264": "AI", "1268": "AG", "1284": "VG",
  "1340": "VI", "1345": "KY", "1441": "BM", "1473": "GD", "1649": "TC",
  "1658": "JM", "1664": "MS", "1670": "MP", "1671": "GU", "1684": "AS",
  "1721": "SX", "1758": "LC", "1767": "DM", "1784": "VC", "1787": "PR",
  "1809": "DO", "1829": "DO", "1849": "DO", "1868": "TT", "1869": "KN",
  "1876": "JM", "1939": "PR",
  "20": "EG", "211": "SS", "212": "MA", "213": "DZ", "216": "TN", "218": "LY",
  "220": "GM", "221": "SN", "222": "MR", "223": "ML", "224": "GN", "225": "CI",
  "226": "BF", "227": "NE", "228": "TG", "229": "BJ", "230": "MU", "231": "LR",
  "232": "SL", "233": "GH", "234": "NG", "235": "TD", "236": "CF", "237": "CM",
  "238": "CV", "239": "ST", "240": "GQ", "241": "GA", "242": "CG", "243": "CD",
  "244": "AO", "245": "GW", "246": "IO", "248": "SC", "249": "SD", "250": "RW",
  "251": "ET", "252": "SO", "253": "DJ", "254": "KE", "255": "TZ", "256": "UG",
  "257": "BI", "258": "MZ", "260": "ZM", "261": "MG", "262": "RE", "263": "ZW",
  "264": "NA", "265": "MW", "266": "LS", "267": "BW", "268": "SZ", "269": "KM",
  "27": "ZA", "290": "SH", "291": "ER", "297": "AW", "298": "FO", "299": "GL",
  "30": "GR", "31": "NL", "32": "BE", "33": "FR", "34": "ES",
  "350": "GI", "351": "PT", "352": "LU", "353": "IE", "354": "IS", "355": "AL",
  "356": "MT", "357": "CY", "358": "FI", "359": "BG",
  "36": "HU", "370": "LT", "371": "LV", "372": "EE", "373": "MD", "374": "AM",
  "375": "BY", "376": "AD", "377": "MC", "378": "SM", "380": "UA", "381": "RS",
  "382": "ME", "383": "XK", "385": "HR", "386": "SI", "387": "BA", "389": "MK",
  "39": "IT", "40": "RO", "41": "CH", "420": "CZ", "421": "SK", "423": "LI",
  "43": "AT", "44": "GB", "45": "DK", "46": "SE", "47": "NO", "48": "PL",
  "49": "DE", "500": "FK", "501": "BZ", "502": "GT", "503": "SV", "504": "HN",
  "505": "NI", "506": "CR", "507": "PA", "508": "PM", "509": "HT",
  "51": "PE", "52": "MX", "53": "CU", "54": "AR", "55": "BR", "56": "CL",
  "57": "CO", "58": "VE", "590": "GP", "591": "BO", "592": "GY", "593": "EC",
  "594": "GF", "595": "PY", "596": "MQ", "597": "SR", "598": "UY", "599": "CW",
  "60": "MY", "61": "AU", "62": "ID", "63": "PH", "64": "NZ", "65": "SG",
  "66": "TH", "670": "TL", "672": "NF", "673": "BN", "674": "NR", "675": "PG",
  "676": "TO", "677": "SB", "678": "VU", "679": "FJ", "680": "PW", "681": "WF",
  "682": "CK", "683": "NU", "685": "WS", "686": "KI", "687": "NC", "688": "TV",
  "689": "PF", "690": "TK", "691": "FM", "692": "MH",
  "7": "RU", "76": "KZ", "77": "KZ",
  "81": "JP", "82": "KR", "84": "VN", "850": "KP", "852": "HK", "853": "MO",
  "855": "KH", "856": "LA", "86": "CN", "880": "BD", "886": "TW",
  "90": "TR", "91": "IN", "92": "PK", "93": "AF", "94": "LK", "95": "MM",
  "960": "MV", "961": "LB", "962": "JO", "963": "SY", "964": "IQ", "965": "KW",
  "966": "SA", "967": "YE", "968": "OM", "970": "PS", "971": "AE", "972": "IL",
  "973": "BH", "974": "QA", "975": "BT", "976": "MN", "977": "NP",
  "98": "IR", "992": "TJ", "993": "TM", "994": "AZ", "995": "GE", "996": "KG",
  "998": "UZ"
};

/**
 * Unit multipliers for the deck's above-floor countries (sell price /
 * $0.008787 blended per-part, 1 decimal). Everything absent multiplies by 1.
 *
 * MX is EXCLUDED on purpose: Mexican tenants' +52 traffic is already priced
 * by the 100-unit clamp + monthly surcharge (Mexico v1), and a multiplier
 * on top would double-charge them. The US-tenant-texting-+52 exposure this
 * leaves open is pre-existing (documented in enterprise-pricing.ts) and
 * belongs to the clamp rework, not this table.
 */
export const SMS_DESTINATION_MULTIPLIERS: Record<string, number> = {
  DK: 18.3,
  FI: 17.2,
  NL: 17.2,
  BE: 15.9,
  CZ: 15.7,
  SE: 14.1,
  RU: 13.3,
  RO: 10.7,
  CL: 10.5,
  PL: 9.5,
  BR: 9.2,
  IE: 6.8,
  GB: 6.3,
  LT: 6.3,
  AU: 5.7,
  ZA: 5.2,
  CN: 3.5,
  TH: 3.5
};

/**
 * Countries the reserve gate refuses outright (enforced in SQL inside
 * try_reserve_sms_outbound_slot; mirrored here for display and tests):
 * embargo-priced and classic toll-fraud destinations. Satellite/premium
 * ranges (+881/+882/+883/+979) have no dial-code entry and refuse as
 * 'destination_unknown' instead.
 */
export const SMS_DESTINATION_DENYLIST: ReadonlySet<string> = new Set([
  "CU", "KP", "SO", "SL", "GN", "GW", "ST"
]);

/** ISO country for an E.164 destination via longest-prefix match, or null. */
export function smsDestinationCountry(e164: string | null | undefined): string | null {
  const cleaned = (e164 ?? "").trim().replace(/[^\d+]/g, "");
  if (!cleaned.startsWith("+")) return null;
  const digits = cleaned.slice(1);
  // Prefixes run 1-4 digits; try longest first.
  for (let len = 4; len >= 1; len -= 1) {
    const iso = SMS_DIAL_CODES[digits.slice(0, len)];
    if (iso) return iso;
  }
  return null;
}

/** Unit multiplier for a resolved destination country (1 for unknown/floor). */
export function smsDestinationMultiplier(country: string | null): number {
  if (!country) return 1;
  return SMS_DESTINATION_MULTIPLIERS[country] ?? 1;
}
