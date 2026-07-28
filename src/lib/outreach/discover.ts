/**
 * Prospecting — discovery through the Google Places Text Search API.
 *
 * The tenant's own targeting drives this: each search term is crossed with
 * each service-area city, and the resulting query list is interleaved
 * round-robin across terms.
 *
 * WHY INTERLEAVE. The obvious layout (all of term one's cities, then all of
 * term two's) plus a window that slides a query at a time serves ONE trade
 * for weeks, which reads like a market signal and is really a rotation
 * artifact. Interleaving means every pass mixes trades, and advancing the
 * window by a FULL run per day means consecutive passes never re-buy the same
 * paid searches.
 *
 * Cost note: the field mask requests `places.websiteUri`, which puts these
 * calls in a higher-priced Places SKU. It is required (a prospect with no
 * site is nothing to say anything about), but do not widen the mask without
 * checking current pricing.
 */

/** One Places hit, narrowed to the fields the mask asks for. */
export type PlacesHit = {
  displayName: string;
  websiteUri: string;
  nationalPhoneNumber: string;
  businessStatus: string;
};

/** A prospect discovery produced, before probing has found anything. */
export type DiscoveredProspect = {
  domain: string;
  businessName: string;
  website: string;
  phone: string;
  vertical: string;
  city: string;
};

/**
 * Site hosts that are somebody else's platform, not the business's own stack.
 * A Facebook page or a Yelp listing has no site of its own to read, so there
 * is no hook to ground a pitch in and no address to find.
 */
export const PLATFORM_HOSTS = [
  "facebook.com",
  "instagram.com",
  "yelp.com",
  "business.site",
  "google.com",
  "linktr.ee",
  "wixsite.com",
  "squarespace.com",
  "godaddysites.com",
  "weebly.com",
  "linkedin.com",
  "nextdoor.com",
  "angi.com",
  "thumbtack.com"
];

/** Places results requested per query — a page is 20, we want the top few. */
export const PLACES_RESULTS_PER_QUERY = 8;

/** Paid Places queries a single discovery pass may run. */
export const QUERIES_PER_RUN = 6;

/**
 * Lowercased registrable-ish domain for a URL: scheme, `www.`, port, path,
 * and query stripped. Returns null when the input is not a usable http(s)
 * URL, which is also how "no website" arrives from Places.
 */
export function normalizeDomain(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  // A bare label ("localhost") is never a real prospect's domain.
  if (!host.includes(".")) return null;
  return host;
}

/** True when the domain is a platform page rather than the business's own site. */
export function isPlatformHosted(domain: string): boolean {
  const host = domain.toLowerCase();
  return PLATFORM_HOSTS.some((p) => host === p || host.endsWith(`.${p}`));
}

/**
 * Terms crossed with cities, interleaved round-robin across terms: index 0 of
 * every term first, then index 1, and so on. Blank entries are dropped so a
 * trailing comma in the owner's settings cannot buy an empty search.
 */
export function buildQueryRotation(
  searchTerms: string[],
  cities: string[]
): Array<{ query: string; vertical: string; city: string }> {
  const terms = searchTerms.map((t) => t.trim()).filter(Boolean);
  const places = cities.map((c) => c.trim()).filter(Boolean);
  const rotation: Array<{ query: string; vertical: string; city: string }> = [];
  for (let cityIndex = 0; cityIndex < places.length; cityIndex += 1) {
    for (const term of terms) {
      rotation.push({
        query: `${term} in ${places[cityIndex]}`,
        vertical: term,
        city: places[cityIndex]
      });
    }
  }
  return rotation;
}

/**
 * The slice of the rotation this pass should run. The window advances by a
 * full run per day (`dayIndex`), wrapping, so a tenant with more queries than
 * one run works through them over days instead of re-buying the same ones.
 */
export function rotationWindow<T>(rotation: T[], dayIndex: number, perRun: number): T[] {
  if (rotation.length === 0 || perRun <= 0) return [];
  const start = ((dayIndex * perRun) % rotation.length + rotation.length) % rotation.length;
  const out: T[] = [];
  for (let i = 0; i < Math.min(perRun, rotation.length); i += 1) {
    out.push(rotation[(start + i) % rotation.length]);
  }
  return out;
}

/** Days since the epoch — the rotation's cursor, so it needs no stored state. */
export function dayIndexFor(now: Date): number {
  return Math.floor(now.getTime() / 86_400_000);
}

export type SearchPlacesDeps = {
  fetchImpl?: typeof fetch;
};

/**
 * One Places Text Search call. Throws on a non-OK response so the sweep can
 * report the failure for this business and carry on with the next one.
 */
export async function searchPlaces(
  apiKey: string,
  query: string,
  deps: SearchPlacesDeps = {}
): Promise<PlacesHit[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.displayName,places.websiteUri,places.nationalPhoneNumber,places.businessStatus"
    },
    body: JSON.stringify({ textQuery: query, pageSize: PLACES_RESULTS_PER_QUERY })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`places_http_${res.status}:${detail.slice(0, 200)}`);
  }
  const json = (await res.json().catch(() => null)) as {
    places?: Array<{
      displayName?: { text?: string };
      websiteUri?: string;
      nationalPhoneNumber?: string;
      businessStatus?: string;
    }>;
  } | null;
  return (json?.places ?? []).map((p) => ({
    displayName: p.displayName?.text ?? "",
    websiteUri: p.websiteUri ?? "",
    nationalPhoneNumber: p.nationalPhoneNumber ?? "",
    businessStatus: p.businessStatus ?? ""
  }));
}

/**
 * Places hits filtered down to prospects worth probing: an own-domain website
 * (no site means nothing to audit, a platform page means no stack of their
 * own), still operational, and unique by domain inside this batch.
 */
export function prospectsFromHits(
  hits: PlacesHit[],
  vertical: string,
  city: string
): DiscoveredProspect[] {
  const out: DiscoveredProspect[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (hit.businessStatus && hit.businessStatus !== "OPERATIONAL") continue;
    const domain = normalizeDomain(hit.websiteUri);
    if (!domain) continue;
    if (isPlatformHosted(domain)) continue;
    if (seen.has(domain)) continue;
    seen.add(domain);
    out.push({
      domain,
      businessName: hit.displayName.trim(),
      website: hit.websiteUri.trim(),
      phone: hit.nationalPhoneNumber.trim(),
      vertical,
      city
    });
  }
  return out;
}
