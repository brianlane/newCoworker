/**
 * Voice zone matcher + allowance weight.
 *
 * Shared by Next.js (re-exported from `src/lib/plans/voice-zone-rates.ts`)
 * and Deno hangup settlement. Edge functions cannot import src/. Keep the
 * generated table next to this file; the generator writes both copies.
 *
 * MATCH THE LRN, NOT ALWAYS THE DIALED NPA. Telnyx Global Voice
 * Conversational termination is billed by Terminating LRN / Term Prefix.
 * Amy's Sep 2026 MDR: dialed +19289512316 (Payson AZ) is `1928` Zone 1 at
 * 0.5c, but Terminating LRN 9283630020 is `1928363` High Cost Zone 5 at 7c.
 * Matching dialed-only is what made auto-cutover PR #1809 look like a
 * Zone 1 list-price move (0.9 to 1.03); it was closed.
 * `voiceTelnyxCentsPerMinute` stays 0.9.
 *
 * TENANT VOICE ALLOWANCE is weighted the same way SMS is: a Zone 5 LRN
 * minute burns 14x the included pool. {@link voiceAllowanceWeight} is that
 * multiplier. Missing LRN stays 1x. Extreme zones cap at
 * {@link VOICE_ALLOWANCE_WEIGHT_CAP} only when the settlement is one
 * Telnyx billed minute or less ({@link VOICE_ALLOWANCE_SHORT_LEG_SECONDS}),
 * so Zone 6 / Canada N11 cannot wipe a month from one AMD or misdial.
 * A longer call uses the full raw zone multiplier on the whole settlement.
 */

import {
  VOICE_RATE_ZONES,
  type VoiceRateZone
} from "./voice-zone-rates.generated.ts";

/**
 * US lower-48 Zone 1, the deck's NANP catch-all and the rate every minute
 * we have ever billed has landed on. Exported as the honest default for a
 * caller with no destination list.
 */
export const NANP_BASELINE_CENTS_PER_MINUTE = 0.5;

/**
 * Ceiling on {@link voiceAllowanceWeight} for a short Telnyx minute
 * (`billable_seconds` omitted, null, or <= {@link VOICE_ALLOWANCE_SHORT_LEG_SECONDS}).
 * Zone 5 Payson is 14x and stays under it either way. Zone 6 is 36.2x and
 * Canada N11 is 150x; those clamp here on AMD / voicemail / misdials, and
 * use the raw multiplier once the call crosses one billed minute.
 */
export const VOICE_ALLOWANCE_WEIGHT_CAP = 20;

/**
 * One Telnyx 60/60 billed minute. Weight cap applies at or below this;
 * above it the raw zone multiplier covers the whole settlement.
 */
export const VOICE_ALLOWANCE_SHORT_LEG_SECONDS = 60;

/**
 * Store / RPC ceiling so a bogus 1e9 cannot land on `zone_weight`.
 * NANP max today is Canada N11 at 150x. Wider than the short-leg cap.
 */
export const VOICE_ALLOWANCE_WEIGHT_STORE_MAX = 200;

type VoiceZoneMatch = {
  iso: string;
  label: string;
  centsPerMinute: number;
  /** The deck prefix that matched, e.g. "1602824" or the catch-all "1". */
  matchedPrefix: string;
  /**
   * Whether the match ran against the Terminating LRN / term prefix, or
   * against the dialed number. Telnyx bills the LRN when it has one.
   */
  matchedOn: "lrn" | "dialed";
};

/**
 * A destination the matcher can price.
 *
 * A bare string is the DIALED number, which is all a contact list or a
 * pasted quote has. When a Telnyx MDR (or anyone else) also has the
 * Terminating LRN or term prefix, pass `{ dialed, lrn }` so the match
 * follows what Telnyx actually bills.
 */
export type VoiceZoneDestination =
  | string
  | null
  | undefined
  | { dialed?: string | null; lrn?: string | null };

type VoiceZoneLookupOptions = {
  /**
   * Telnyx Terminating LRN, or a Telnyx term prefix such as "1928363".
   * When this parses as NANP, zone-match uses it instead of the dialed
   * number. Empty / non-NANP values are ignored and the dialed number
   * is used.
   */
  lrn?: string | null;
  /**
   * Already-ceiled Telnyx billable seconds for this settlement. Cap 20
   * applies when omitted, null, or <= {@link VOICE_ALLOWANCE_SHORT_LEG_SECONDS}.
   * Above that, {@link voiceAllowanceWeight} returns the raw zone rate.
   * Hangup and MDR pass {@link voiceAllowanceRawWeight} instead and let
   * SQL apply this same rule from the settlement's billable_seconds.
   */
  billableSeconds?: number | null;
};

/**
 * Telnyx MDR / CSV keys that have carried the billed terminating identity.
 *
 * Portal CSV (Amy Sep 2026 sip-outbound): "Terminating LRN", "Term Prefix".
 * API detail-records use snake_case variants. Hangup webhooks usually
 * omit them. `voice_settlements.terminating_lrn` is stamped when a
 * payload or later MDR actually carries one. The measure script still
 * discovers columns at runtime.
 */
const TELNYX_LRN_FIELD_KEYS = [
  "terminating_lrn",
  "term_lrn",
  "lrn",
  "term_prefix",
  "terminating_prefix",
  "Terminating LRN",
  "Term Prefix"
] as const;

type ZoneIndex = {
  /** Exact digit prefixes, bucketed by length so lookup can go longest-first. */
  exact: Map<number, Map<string, VoiceRateZone>>;
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
  let maxLength = 0;

  // Exact lookup only. The deck's wildcard rows (Canada's "1XXX310" service
  // codes) are expanded into concrete prefixes by the generator, against the
  // area codes that country actually has. Matching "X" as "any digit" here
  // would let Canada's 75c/min N11 rate win against any US number with a
  // 310 or N11 exchange.
  for (const zone of VOICE_RATE_ZONES) {
    for (const prefix of zone.prefixes.split(" ")) {
      maxLength = Math.max(maxLength, prefix.length);
      let bucket = exact.get(prefix.length);
      if (!bucket) {
        bucket = new Map<string, VoiceRateZone>();
        exact.set(prefix.length, bucket);
      }
      bucket.set(prefix, zone);
    }
  }

  return { exact, maxLength };
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
 * Digits Telnyx will rate against: a full NANP number, or a deck prefix
 * that already includes the leading 1 (`1928363`).
 *
 * Dialed numbers stay on {@link nanpDigits} (10 or 11 digits) so a shredded
 * fragment cannot silently price. LRN / term prefix is looser because the
 * MDR sometimes gives the prefix rather than the 10-digit LRN.
 */
function lrnLookupDigits(value: string | null | undefined): string | null {
  const asNumber = nanpDigits(value);
  if (asNumber) return asNumber;
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("1") && digits.length >= 2 && digits.length <= 15) {
    return digits;
  }
  return null;
}

function isLookupObject(
  value: VoiceZoneDestination
): value is { dialed?: string | null; lrn?: string | null } {
  return typeof value === "object" && value !== null;
}

function matchDigits(
  digits: string,
  matchedOn: VoiceZoneMatch["matchedOn"]
): VoiceZoneMatch | null {
  const { exact, maxLength } = index();
  for (let length = Math.min(maxLength, digits.length); length >= 1; length -= 1) {
    const candidate = digits.slice(0, length);
    const hit = exact.get(length)?.get(candidate);
    if (hit) {
      return {
        iso: hit.iso,
        label: hit.label,
        centsPerMinute: hit.centsPerMinute,
        matchedPrefix: candidate,
        matchedOn
      };
    }
  }
  return null;
}

/**
 * Pull a Terminating LRN or term prefix out of a Telnyx MDR / CSV row.
 *
 * First non-empty known key wins. Returns null when the row has none of
 * those fields. Does not read `from` / `to`: those are the dialed
 * identity, and treating them as LRN would guess from the NPA.
 */
export function telnyxTerminatingLrnFromFields(
  record: Record<string, unknown> | null | undefined
): string | null {
  if (!record) return null;
  for (const key of TELNYX_LRN_FIELD_KEYS) {
    const raw = record[key];
    const asString =
      typeof raw === "string"
        ? raw.trim()
        : typeof raw === "number" && Number.isFinite(raw)
          ? String(Math.trunc(raw))
          : "";
    if (asString.length === 0) continue;
    if (lrnLookupDigits(asString)) return asString;
  }
  return null;
}

/**
 * The rate zone Telnyx will bill for a call to this destination, or null
 * if nothing NANP-parseable was supplied.
 *
 * Prefers LRN / term prefix over the dialed number when both are present.
 * That is what Telnyx bills: Amy Payson +19289512316 is Zone 1 on the
 * dialed NPA and Zone 5 on Terminating LRN 9283630020. A dialed-only
 * call (contact list, quote paste) keeps the historical behavior and can
 * understate ported high-cost exposure.
 *
 * Longest prefix wins, which is the whole point: a 7 digit NPA-NXX row has
 * to beat the 4 digit NPA row it sits inside, and both have to beat the
 * bare "1" catch-all. Getting that order backwards would price every US
 * call at the Zone 1 baseline and reproduce the exact blind spot this
 * module exists to remove.
 */
export function voiceZoneFor(
  destination: VoiceZoneDestination = null,
  options?: VoiceZoneLookupOptions
): VoiceZoneMatch | null {
  const dialed = isLookupObject(destination) ? destination.dialed : destination;
  const lrn = options?.lrn ?? (isLookupObject(destination) ? destination.lrn : undefined);

  const lrnDigits = lrnLookupDigits(lrn);
  if (lrnDigits) {
    // A parseable LRN that matches nothing (only possible if a future deck
    // drops the NANP catch-all) must not fall back to dialed: that would
    // hide the identity Telnyx billed.
    return matchDigits(lrnDigits, "lrn");
  }

  const dialedDigits = nanpDigits(dialed);
  if (!dialedDigits) return null;
  return matchDigits(dialedDigits, "dialed");
}

/**
 * Clamp a raw zone multiplier to the duration rule.
 *
 * `billableSeconds` omitted / null / <= 60: short-leg cap 20.
 * `billableSeconds` > 60: full raw weight, store-ceiling 200.
 * Always floors at 1. SQL `voice_effective_allowance_weight` is the
 * lockstep copy used at finalize / MDR apply.
 */
export function applyVoiceAllowanceDurationCap(
  rawWeight: number,
  billableSeconds?: number | null
): number {
  const raw = Math.min(
    VOICE_ALLOWANCE_WEIGHT_STORE_MAX,
    Math.max(1, rawWeight)
  );
  if (
    typeof billableSeconds === "number" &&
    billableSeconds > VOICE_ALLOWANCE_SHORT_LEG_SECONDS
  ) {
    return raw;
  }
  return Math.min(VOICE_ALLOWANCE_WEIGHT_CAP, raw);
}

/**
 * Uncapped zone multiplier (zone ¢ / 0.5), store-ceiling only.
 *
 * Hangup and MDR pass this through to SQL so the duration cap can use
 * that settlement's billable_seconds, not a guess from the payload.
 */
export function voiceAllowanceRawWeight(
  destination: VoiceZoneDestination = null,
  options?: VoiceZoneLookupOptions
): number {
  const lrn = options?.lrn ?? (isLookupObject(destination) ? destination.lrn : undefined);
  if (!lrnLookupDigits(lrn)) return 1;
  const zone = voiceZoneFor(null, { lrn });
  if (!zone || zone.matchedOn !== "lrn") return 1;
  if (!(zone.centsPerMinute > NANP_BASELINE_CENTS_PER_MINUTE)) return 1;
  return applyVoiceAllowanceDurationCap(
    zone.centsPerMinute / NANP_BASELINE_CENTS_PER_MINUTE,
    Number.POSITIVE_INFINITY
  );
}

/**
 * How many included-pool seconds one billed Telnyx minute should consume.
 *
 * Same shape as SMS destination multipliers: Zone 1 is 1x, Zone 5 at 7c
 * is 14x (7 / 0.5). Requires a parseable LRN / term prefix. Missing LRN,
 * a dialed-only number, toll-free at 0c, and Zone 1 at 0.5c all return 1.
 * Does not guess from the dialed NPA.
 *
 * The billed minute itself is already ceiled by settlement (33s → 60).
 * Multiply that 60 by this weight; do not ceil again.
 *
 * Duration: omit / null / <= 60 billable seconds keeps
 * {@link VOICE_ALLOWANCE_WEIGHT_CAP}. Above 60, the raw zone rate
 * applies to the whole settlement.
 */
export function voiceAllowanceWeight(
  destination: VoiceZoneDestination = null,
  options?: VoiceZoneLookupOptions
): number {
  return applyVoiceAllowanceDurationCap(
    voiceAllowanceRawWeight(destination, options),
    options?.billableSeconds
  );
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
 * Pull dial-able numbers out of free text an operator pasted.
 *
 * Splitting on "every non-digit" looks right and is wrong: it shreds
 * "(602) 838-4497" into "602", "838" and "4497", none of which is an NANP
 * number. The blend then prices nothing, falls back to the baseline, and a
 * pasted rural list is silently quoted as lower-48 traffic. That failure is
 * invisible, which is the worst kind.
 *
 * So: split only on the separators between ENTRIES (newline, comma,
 * semicolon, tab) and let each entry keep its own formatting, which
 * `nanpDigits` strips. An entry that still does not parse is passed through
 * rather than dropped, so it lands in the `unpriced` count where a human can
 * see it, instead of disappearing.
 *
 * The one ambiguous case is several numbers separated by spaces alone
 * ("+16028384497 +16055230000"): that entry is retried as whitespace-split
 * pieces, and only accepted if EVERY piece is itself a valid number, since
 * "602 838 4497" would otherwise become three bogus entries.
 */
export function parseDestinationList(text: string): string[] {
  const out: string[] = [];
  for (const rawEntry of text.split(/[\n,;\t]+/)) {
    const entry = rawEntry.trim();
    if (entry.length === 0) continue;
    if (nanpDigits(entry) !== null) {
      out.push(entry);
      continue;
    }
    const pieces = entry.split(/\s+/).filter((piece) => piece.length > 0);
    if (pieces.length > 1 && pieces.every((piece) => nanpDigits(piece) !== null)) {
      out.push(...pieces);
      continue;
    }
    // Unparseable: keep it so it shows up as unpriced rather than vanishing.
    out.push(entry);
  }
  return out;
}

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
 * Entries may be dialed strings or `{ dialed, lrn }`. LRN wins per
 * {@link voiceZoneFor}. A contacts-only list has no LRN and can understate
 * ported high-cost exposure; that is documented, not hidden.
 *
 * Returns the Zone 1 baseline when nothing at all could be priced, so a
 * caller always has a usable number; `priced === 0` says not to trust it.
 */
export function blendedVoiceTerminationRate(
  destinations: readonly VoiceZoneDestination[]
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
