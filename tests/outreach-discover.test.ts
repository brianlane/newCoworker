/**
 * Prospecting discovery (src/lib/outreach/discover.ts): domain normalization,
 * platform-host exclusion, the interleaved query rotation and its per-day
 * window, the Places call, and the filter that decides what is worth probing.
 *
 * The rotation assertions are the honedtech regression: a rotation grouped by
 * vertical with a one-query slide serves a single trade for weeks and reads
 * like a market signal.
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildQueryRotation,
  dayIndexFor,
  isPlatformHosted,
  normalizeDomain,
  PLACES_RESULTS_PER_QUERY,
  prospectsFromHits,
  QUERIES_PER_RUN,
  rotationWindow,
  searchPlaces,
  type PlacesHit
} from "@/lib/outreach/discover";

function hit(over: Partial<PlacesHit> = {}): PlacesHit {
  return {
    displayName: "Acme HVAC",
    websiteUri: "https://www.acmehvac.com/",
    nationalPhoneNumber: "(602) 555-0100",
    businessStatus: "OPERATIONAL",
    ...over
  };
}

describe("normalizeDomain", () => {
  it("strips scheme, www, port, and path", () => {
    expect(normalizeDomain("https://www.Acme-HVAC.com/contact?x=1")).toBe("acme-hvac.com");
    expect(normalizeDomain("http://acme.com:8080")).toBe("acme.com");
    expect(normalizeDomain("https://sub.acme.co.uk/")).toBe("sub.acme.co.uk");
  });

  it("rejects blanks, non-URLs, non-http schemes, and bare hostnames", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
    expect(normalizeDomain("not a url")).toBeNull();
    expect(normalizeDomain("ftp://acme.com")).toBeNull();
    expect(normalizeDomain("http://localhost")).toBeNull();
  });
});

describe("isPlatformHosted", () => {
  it("matches the platform itself and its subdomains, not lookalikes", () => {
    expect(isPlatformHosted("facebook.com")).toBe(true);
    expect(isPlatformHosted("acme.business.site")).toBe(true);
    expect(isPlatformHosted("ACME.wixsite.com")).toBe(true);
    expect(isPlatformHosted("acmehvac.com")).toBe(false);
    // A domain that merely ENDS with the letters must not match.
    expect(isPlatformHosted("notfacebook.com")).toBe(false);
  });
});

describe("buildQueryRotation", () => {
  it("crosses terms with cities and interleaves across terms", () => {
    const rotation = buildQueryRotation(["hvac", "plumber"], ["Phoenix", "Mesa"]);
    expect(rotation.map((r) => r.query)).toEqual([
      "hvac in Phoenix",
      "plumber in Phoenix",
      "hvac in Mesa",
      "plumber in Mesa"
    ]);
    // Consecutive queries change trade, which is the whole point: a
    // vertical-grouped list served one trade for weeks at a time.
    expect(rotation[0].vertical).not.toBe(rotation[1].vertical);
    expect(rotation[0]).toMatchObject({ vertical: "hvac", city: "Phoenix" });
  });

  it("drops blank terms and cities", () => {
    expect(buildQueryRotation([" hvac ", "  "], ["Phoenix", ""])).toEqual([
      { query: "hvac in Phoenix", vertical: "hvac", city: "Phoenix" }
    ]);
    expect(buildQueryRotation([], ["Phoenix"])).toEqual([]);
    expect(buildQueryRotation(["hvac"], [])).toEqual([]);
  });
});

describe("rotationWindow", () => {
  const rotation = [0, 1, 2, 3, 4];

  it("advances a full run per day and wraps", () => {
    expect(rotationWindow(rotation, 0, 2)).toEqual([0, 1]);
    expect(rotationWindow(rotation, 1, 2)).toEqual([2, 3]);
    // Wraps around the end rather than running short.
    expect(rotationWindow(rotation, 2, 2)).toEqual([4, 0]);
  });

  it("never returns more than the rotation holds, and handles degenerate input", () => {
    expect(rotationWindow(rotation, 0, 99)).toHaveLength(rotation.length);
    expect(rotationWindow([], 3, 2)).toEqual([]);
    expect(rotationWindow(rotation, 3, 0)).toEqual([]);
    // A negative day index (a clock before the epoch) still lands in range.
    expect(rotationWindow(rotation, -1, 2)).toEqual([3, 4]);
  });

  it("derives the day index from the clock", () => {
    expect(dayIndexFor(new Date("1970-01-01T00:00:00.000Z"))).toBe(0);
    expect(dayIndexFor(new Date("1970-01-03T12:00:00.000Z"))).toBe(2);
  });
});

describe("searchPlaces", () => {
  it("sends the query with the field mask and maps the response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        places: [
          {
            displayName: { text: "Acme HVAC" },
            websiteUri: "https://acmehvac.com",
            nationalPhoneNumber: "(602) 555-0100",
            businessStatus: "OPERATIONAL"
          },
          {}
        ]
      })
    })) as unknown as typeof fetch;

    const hits = await searchPlaces("key", "hvac in Phoenix", { fetchImpl });
    expect(hits).toEqual([
      {
        displayName: "Acme HVAC",
        websiteUri: "https://acmehvac.com",
        nationalPhoneNumber: "(602) 555-0100",
        businessStatus: "OPERATIONAL"
      },
      // A hit missing every optional field maps to blanks, never undefined.
      { displayName: "", websiteUri: "", nationalPhoneNumber: "", businessStatus: "" }
    ]);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers["X-Goog-Api-Key"]).toBe("key");
    // websiteUri is the field that makes this a pricier SKU; it must stay, and
    // nothing else may quietly join it.
    expect(headers["X-Goog-FieldMask"]).toBe(
      "places.displayName,places.websiteUri,places.nationalPhoneNumber,places.businessStatus"
    );
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      textQuery: "hvac in Phoenix",
      pageSize: PLACES_RESULTS_PER_QUERY
    });
  });

  it("treats a missing places array and an unparseable body as no results", async () => {
    const empty = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await searchPlaces("key", "q", { fetchImpl: empty })).toEqual([]);

    const unparseable = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error("not json");
      }
    })) as unknown as typeof fetch;
    expect(await searchPlaces("key", "q", { fetchImpl: unparseable })).toEqual([]);
  });

  it("throws with the status so the sweep can report the business's failure", async () => {
    const failing = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "RESOURCE_EXHAUSTED"
    })) as unknown as typeof fetch;
    await expect(searchPlaces("key", "q", { fetchImpl: failing })).rejects.toThrow(
      /places_http_429:RESOURCE_EXHAUSTED/
    );

    const unreadable = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("stream closed");
      }
    })) as unknown as typeof fetch;
    await expect(searchPlaces("key", "q", { fetchImpl: unreadable })).rejects.toThrow(
      /places_http_500/
    );
  });

  it("defaults to the global fetch when no impl is injected", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, json: async () => ({ places: [] }) } as unknown as Response);
    expect(await searchPlaces("key", "q")).toEqual([]);
    spy.mockRestore();
  });
});

describe("prospectsFromHits", () => {
  it("keeps operational businesses with their own site, de-duped by domain", () => {
    const prospects = prospectsFromHits(
      [
        hit(),
        // Same business, second listing: one prospect, not two.
        hit({ websiteUri: "http://acmehvac.com/about" }),
        hit({ displayName: "Closed Co", businessStatus: "CLOSED_PERMANENTLY" }),
        hit({ displayName: "No Site Co", websiteUri: "" }),
        hit({ displayName: "Page Only", websiteUri: "https://facebook.com/pageonly" }),
        hit({ displayName: "Other Co", websiteUri: "https://otherco.com", businessStatus: "" })
      ],
      "hvac",
      "Phoenix"
    );
    expect(prospects).toEqual([
      {
        domain: "acmehvac.com",
        businessName: "Acme HVAC",
        website: "https://www.acmehvac.com/",
        phone: "(602) 555-0100",
        vertical: "hvac",
        city: "Phoenix"
      },
      {
        domain: "otherco.com",
        businessName: "Other Co",
        website: "https://otherco.com",
        phone: "(602) 555-0100",
        vertical: "hvac",
        city: "Phoenix"
      }
    ]);
  });

  it("caps a run at the documented number of paid queries", () => {
    // Guards the cost lever: a change here changes the Places bill.
    expect(QUERIES_PER_RUN).toBe(6);
  });
});
