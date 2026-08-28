/**
 * What one outbound voice MINUTE costs us in termination, by destination.
 *
 * Telnyx does not price voice per country. It prices per NPA-NXX, and the
 * spread inside the US alone is 36x: the lower 48 baseline is 0.5c/min,
 * while 6,818 "High Cost (Zone 5)" prefixes are 7c and 36 Zone 6 prefixes
 * are 18.1c. Those prefixes are overwhelmingly rural (605 South Dakota, 701
 * North Dakota, 712 Iowa, 218 Minnesota, 580 Oklahoma, 406 Montana), which
 * is exactly where a real-estate tenant working a farm list dials.
 *
 * Everything that costs from ACTUALS (`fleet-cost.ts`, and the Costs and
 * Revenue pages behind it) is already correct without this module: it reads
 * real spend out of `telnyx_cost_daily`. This exists for the FORWARD
 * direction, where {@link estimateEnterpriseMonthlyCost} has to assume a
 * per-minute rate before a single call has been placed. That assumption was
 * a flat 0.9c/min back-calibrated from the June and July 2026 invoices,
 * whose traffic was almost entirely Phoenix metro, so it silently encodes
 * "every minute is Zone 1".
 *
 * Measured against the live fleet on 2026-08-28: all 104 outbound legs we
 * have ever placed landed in US Zone 1, and the blended rate over all 573
 * dialable contacts is 0.619c/min, 1.24x baseline. So this is not fixing a
 * live overspend. It removes a blind spot that only shows up on a rural
 * list, where a Zone 5 minute is 10c all-in against a 3.15c model.
 *
 * The table is generated, never hand-edited. See
 * `scripts/generate-voice-zone-rates.ts` for how to refresh it, and why the
 * refresh needs a human.
 */

import {
  VOICE_RATE_ZONES,
  type VoiceRateZone
} from "@/lib/plans/voice-zone-rates.generated";

/**
 * US lower-48 Zone 1, the deck's NANP catch-all and the rate every minute
 * we have ever billed has landed on. Exported as the honest default for a
 * caller with no destination list.
 */
export const NANP_BASELINE_CENTS_PER_MINUTE = 0.5;

type VoiceZoneMatch = {
  iso: string;
  label: string;
  centsPerMinute: number;
  /** The deck prefix that matched, e.g. "1602824" or the catch-all "1". */
  matchedPrefix: string;
};

type ZoneIndex = {
  /** Exact digit prefixes, bucketed by length so lookup can go longest-first. */
  exact: Map<number, Map<string, VoiceRateZone>>;
  /** Wildcard patterns (Canada's N11 rows), with the length they consume. */
  wildcards: { length: number; test: RegExp; zone: VoiceRateZone }[];
  /** Longest prefix the deck defines, the starting point for a lookup. */
  maxLength: number;
};

let cachedIndex: ZoneIndex | null = null;

/**
 * Build the prefix index once, on first lookup rather than at import.
 *
 * The generated module is ~200 KB of string literals; parsing it into 22k
 * Map entries at module load would put that cost on every server start
 * including the many that never price a call.
 */
function buildIndex(): ZoneIndex {
  const exact = new Map<number, Map<string, VoiceRateZone>>();
  const wildcards: ZoneIndex["wildcards"] = [];
  let maxLength = 0;

  for (const zone of VOICE_RATE_ZONES) {
    for (const prefix of zone.prefixes.split(" ")) {
      maxLength = Math.max(maxLength, prefix.length);
      if (prefix.includes("X")) {
        // "1XXX310" -> /^1\d\d\d310$/. Anchored so it consumes exactly its
        // own length and competes at that length, not at any other.
        wildcards.push({
          length: prefix.length,
          test: new RegExp(`^${prefix.replace(/X/g, "\\d")}$`),
          zone
        });
        continue;
      }
      let bucket = exact.get(prefix.length);
      if (!bucket) {
        bucket = new Map<string, VoiceRateZone>();
        exact.set(prefix.length, bucket);
      }
      bucket.set(prefix, zone);
    }
  }

  return { exact, wildcards, maxLength };
}

function index(): ZoneIndex {
  cachedIndex ??= buildIndex();
  return cachedIndex;
}

/**
 * Reduce a phone number to NANP dialing digits, or null if it is not one.
 *
 * Accepts "+16028384497", "16028384497", "(602) 838-4497" and "6028384497".
 * A bare 10 digit number is assumed NANP and given its country code, which
 * matches how the rest of the codebase treats stored US numbers.
 *
 * Anything non-NANP returns null rather than a guess. The deck's other 211
 * countries are real, but we do not originate to them, so pretending to
 * price them would be a number nobody has ever checked against an invoice.
 */
function nanpDigits(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, "");
  if (digits.length === 10) return `1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return digits;
  return null;
}

/**
 * The rate zone Telnyx will bill for a call to this number, or null if the
 * number is not NANP.
 *
 * Longest prefix wins, which is the whole point: a 7 digit NPA-NXX row has
 * to beat the 4 digit NPA row it sits inside, and both have to beat the
 * bare "1" catch-all. Getting that order backwards would price every US
 * call at the Zone 1 baseline and reproduce the exact blind spot this
 * module exists to remove.
 */
export function voiceZoneFor(e164: string | null | undefined): VoiceZoneMatch | null {
  const digits = nanpDigits(e164);
  if (!digits) return null;

  const { exact, wildcards, maxLength } = index();
  for (let length = Math.min(maxLength, digits.length); length >= 1; length -= 1) {
    const candidate = digits.slice(0, length);
    const hit = exact.get(length)?.get(candidate);
    if (hit) {
      return {
        iso: hit.iso,
        label: hit.label,
        centsPerMinute: hit.centsPerMinute,
        matchedPrefix: candidate
      };
    }
    for (const wildcard of wildcards) {
      if (wildcard.length === length && wildcard.test.test(candidate)) {
        return {
          iso: wildcard.zone.iso,
          label: wildcard.zone.label,
          centsPerMinute: wildcard.zone.centsPerMinute,
          matchedPrefix: candidate
        };
      }
    }
  }
  return null;
}

type BlendedVoiceRate = {
  /** Mean termination cents/min across the priced destinations. */
  centsPerMinute: number;
  /** Destinations that resolved to a zone. */
  priced: number;
  /** Destinations that did not (non-NANP), excluded from the mean. */
  unpriced: number;
  /**
   * The most expensive zone anywhere in the list, or null if nothing
   * priced. A blend alone cannot distinguish "every number is slightly
   * above baseline" from "one number is Zone 6", and those are different
   * problems, so the caller gets to name the worst one.
   */
  priciestZone: { label: string; iso: string; centsPerMinute: number } | null;
};

/**
 * The average termination rate across a set of destinations, for sizing a
 * deal from a prospect's actual contact list instead of from a guess.
 *
 * Unpriceable destinations are COUNTED AND EXCLUDED rather than folded in
 * at the baseline. Silently substituting 0.5c for a number we could not
 * price would drag the blend toward "cheap" precisely when the unknown
 * destinations are the international ones that are not. Callers get the
 * count and decide.
 *
 * Returns the Zone 1 baseline when nothing at all could be priced, so a
 * caller always has a usable number; `priced === 0` says not to trust it.
 */
export function blendedVoiceTerminationRate(
  destinations: readonly (string | null | undefined)[]
): BlendedVoiceRate {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  let priciestZone: BlendedVoiceRate["priciestZone"] = null;
  for (const destination of destinations) {
    const zone = voiceZoneFor(destination);
    if (zone === null) {
      unpriced += 1;
      continue;
    }
    total += zone.centsPerMinute;
    priced += 1;
    if (priciestZone === null || zone.centsPerMinute > priciestZone.centsPerMinute) {
      priciestZone = {
        label: zone.label,
        iso: zone.iso,
        centsPerMinute: zone.centsPerMinute
      };
    }
  }
  if (priced === 0) {
    return {
      centsPerMinute: NANP_BASELINE_CENTS_PER_MINUTE,
      priced,
      unpriced,
      priciestZone: null
    };
  }
  // 4 decimal places of a cent: enough to keep a 0.619c blend distinct from
  // the 0.5c baseline, without carrying float dust into a rendered price.
  return {
    centsPerMinute: Math.round((total / priced) * 10_000) / 10_000,
    priced,
    unpriced,
    priciestZone
  };
}
