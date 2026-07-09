/**
 * DID auto-purchase search planning.
 *
 * A new tenant's phone-number search runs through an ordered cascade of
 * search specs, trying the next one whenever Telnyx has no inventory for
 * the current one:
 *
 *   1. `requested`        — the area code the owner explicitly chose at
 *                           signup (`businesses.preferred_area_code`).
 *   2. `owner_local`      — the NPA derived from the owner's own phone
 *                           number (`extractNanpAreaCode`).
 *   3. `platform_default` — `TELNYX_DEFAULT_AREA_CODE` (+ the
 *                           `TELNYX_DEFAULT_STATE` filter).
 *   4. `any`              — any number in the default country. Always
 *                           last, so a signup never fails outright just
 *                           because a specific area code sold out.
 *
 * Country awareness: the NANP spans the US and Canada, and Telnyx files
 * inventory under separate `country_code`s — a 519 (Ontario) search under
 * `US` returns nothing (the Jul 8 2026 Truly Insurance signup needed a
 * manual CA-scoped order for exactly this reason). Specs therefore carry
 * the country their NPA belongs to, via a static Canadian-NPA table.
 */

/**
 * Geographic Canadian NPAs (as assigned by the CNA, mid-2026). Non-geographic
 * codes (600/622/633/644/655/677/688) are deliberately excluded — they're
 * not purchasable local inventory. A stale entry degrades gracefully: the
 * search just returns no inventory and the cascade moves on.
 */
export const CANADIAN_NPAS: ReadonlySet<string> = new Set([
  "204", "226", "236", "249", "250", "257", "263", "289",
  "306", "343", "354", "365", "367", "368", "382", "387",
  "403", "416", "418", "428", "431", "437", "438", "450",
  "468", "474", "506", "514", "519", "548", "579", "581",
  "584", "587", "604", "613", "639", "647", "672", "683",
  "705", "709", "742", "753", "778", "780", "782", "807",
  "819", "825", "867", "873", "879", "902", "905"
]);

/** Which country a NANP area code's inventory is filed under at Telnyx. */
export function countryForNpa(npa: string, defaultCountry: string): string {
  return CANADIAN_NPAS.has(npa) ? "CA" : defaultCountry;
}

/**
 * Normalize a free-form "preferred area code" input (signup form / DB
 * column) to a canonical 3-digit NPA, or null when unusable. Accepts
 * decorations like "(519)" or "519 "; rejects anything that isn't exactly
 * three digits with a leading 2-9 after cleanup (NPAs never start 0/1).
 */
export function normalizePreferredAreaCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return /^[2-9]\d{2}$/.test(digits) ? digits : null;
}

export type DidSearchSpec = {
  /** Which cascade tier produced this spec (drives logs + progress copy). */
  source: "requested" | "owner_local" | "platform_default" | "any";
  countryCode: string;
  areaCode?: string;
  administrativeArea?: string;
};

/**
 * Build the ordered, deduplicated search cascade. Rules:
 *
 *   - A concrete NPA pins the locale, so `requested`/`owner_local` specs
 *     never carry the env state filter (a contradictory
 *     `administrativeArea` would zero out the search).
 *   - The platform-default spec keeps the state filter (its NPA + state
 *     describe the same locale by configuration).
 *   - Dedupe on NPA: a later tier repeating an earlier tier's area code
 *     would re-run an identical-or-narrower search, so it is dropped.
 *   - The `any` spec is always last and never filters by area code or
 *     state.
 */
export function buildDidSearchPlan(args: {
  preferredAreaCode: string | null;
  ownerAreaCode: string | null;
  defaultCountry: string;
  defaultAreaCode?: string;
  defaultState?: string;
}): DidSearchSpec[] {
  const specs: DidSearchSpec[] = [];
  const seenNpas = new Set<string>();

  if (args.preferredAreaCode) {
    specs.push({
      source: "requested",
      countryCode: countryForNpa(args.preferredAreaCode, args.defaultCountry),
      areaCode: args.preferredAreaCode,
      administrativeArea: undefined
    });
    seenNpas.add(args.preferredAreaCode);
  }

  if (args.ownerAreaCode && !seenNpas.has(args.ownerAreaCode)) {
    specs.push({
      source: "owner_local",
      countryCode: countryForNpa(args.ownerAreaCode, args.defaultCountry),
      areaCode: args.ownerAreaCode,
      administrativeArea: undefined
    });
    seenNpas.add(args.ownerAreaCode);
  }

  if (args.defaultAreaCode && !seenNpas.has(args.defaultAreaCode)) {
    specs.push({
      source: "platform_default",
      countryCode: args.defaultCountry,
      areaCode: args.defaultAreaCode,
      administrativeArea: args.defaultState
    });
    seenNpas.add(args.defaultAreaCode);
  }

  specs.push({
    source: "any",
    countryCode: args.defaultCountry,
    areaCode: undefined,
    administrativeArea: undefined
  });

  return specs;
}
