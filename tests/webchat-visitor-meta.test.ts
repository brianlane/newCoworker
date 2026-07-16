import { describe, expect, it } from "vitest";
import {
  appendVisitorPage,
  buildVisitorMeta,
  deviceFromUserAgent,
  formatVisitorDevice,
  formatVisitorLocation,
  formatVisitorSource,
  geoFromRequestHeaders,
  parseVisitorMeta,
  visitorMetaDisplayRows,
  webchatClientMetaSchema,
  VISITOR_META_MAX_PAGES,
  VISITOR_META_MAX_URL_CHARS,
  type WebchatVisitorMeta
} from "@/lib/webchat/visitor-meta";

describe("webchatClientMetaSchema", () => {
  it("accepts a full valid payload and truncates long URLs", () => {
    const parsed = webchatClientMetaSchema.parse({
      page: "https://example.com/" + "p".repeat(1500),
      referrer: "https://google.com/",
      utm: { source: "google", medium: "cpc", campaign: "brand", term: "t", content: "c" },
      language: "en-US",
      screen: "1440x900",
      timezone: "America/Phoenix",
      returning: true,
      timeOnPageMs: 45_000
    });
    expect(parsed.page).toHaveLength(VISITOR_META_MAX_URL_CHARS);
    expect(parsed.utm?.source).toBe("google");
    expect(parsed.returning).toBe(true);
  });

  it("degrades invalid fields to undefined instead of failing the payload", () => {
    // The loader sends screen:"" when dimensions are unavailable — that must
    // not drop the rest of the payload (Bugbot Medium on PR #653).
    const parsed = webchatClientMetaSchema.parse({
      screen: "",
      language: "en",
      timeOnPageMs: -1,
      returning: "yes",
      page: "   ",
      referrer: 42,
      utm: "not-an-object",
      timezone: ""
    });
    expect(parsed.language).toBe("en");
    expect(parsed.screen).toBeUndefined();
    expect(parsed.timeOnPageMs).toBeUndefined();
    expect(parsed.returning).toBeUndefined();
    expect(parsed.page).toBeUndefined();
    expect(parsed.referrer).toBeUndefined();
    expect(parsed.utm).toBeUndefined();
    expect(parsed.timezone).toBeUndefined();

    expect(webchatClientMetaSchema.parse({ screen: "wide" }).screen).toBeUndefined();
    expect(webchatClientMetaSchema.parse({ timeOnPageMs: 1.5 }).timeOnPageMs).toBeUndefined();
    expect(
      webchatClientMetaSchema.parse({ timeOnPageMs: 8 * 24 * 60 * 60 * 1000 }).timeOnPageMs
    ).toBeUndefined();
    expect(webchatClientMetaSchema.safeParse({}).success).toBe(true);
  });
});

describe("geoFromRequestHeaders", () => {
  it("reads and decodes the Vercel geo headers", () => {
    const h = new Headers({
      "x-vercel-ip-country": "BR",
      "x-vercel-ip-country-region": "SP",
      "x-vercel-ip-city": "S%C3%A3o%20Paulo",
      "x-vercel-ip-timezone": "America/Sao_Paulo"
    });
    expect(geoFromRequestHeaders(h)).toEqual({
      country: "BR",
      region: "SP",
      city: "São Paulo",
      timezone: "America/Sao_Paulo"
    });
  });

  it("returns undefined with no headers and survives bad percent-encoding", () => {
    expect(geoFromRequestHeaders(new Headers())).toBeUndefined();
    const bad = new Headers({ "x-vercel-ip-city": "50%" });
    expect(geoFromRequestHeaders(bad)).toEqual({ city: "50%" });
  });
});

describe("deviceFromUserAgent", () => {
  it("summarizes common UAs", () => {
    expect(
      deviceFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      )
    ).toEqual({ browser: "Safari", os: "iOS", mobile: true });
    expect(
      deviceFromUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36"
      )
    ).toEqual({ browser: "Chrome", os: "Android", mobile: true });
    expect(
      deviceFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0"
      )
    ).toEqual({ browser: "Edge", os: "Windows", mobile: false });
    expect(
      deviceFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
      )
    ).toEqual({ browser: "Chrome", os: "macOS", mobile: false });
    expect(
      deviceFromUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0")
    ).toEqual({ browser: "Firefox", os: "Linux", mobile: false });
    expect(
      deviceFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/111.0.0.0"
      )
    ).toEqual({ browser: "Opera", os: "Windows", mobile: false });
    expect(
      deviceFromUserAgent(
        "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
      )
    ).toEqual({ browser: "Chrome", os: "ChromeOS", mobile: false });
  });

  it("returns undefined for empty or unrecognizable UAs", () => {
    expect(deviceFromUserAgent(null)).toBeUndefined();
    expect(deviceFromUserAgent("   ")).toBeUndefined();
    expect(deviceFromUserAgent("curl/8.4.0")).toBeUndefined();
  });

  it("keeps partial matches: OS without a browser, browser without an OS", () => {
    expect(deviceFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) like Gecko")).toEqual({
      os: "Windows",
      mobile: false
    });
    expect(deviceFromUserAgent("Firefox/126.0")).toEqual({ browser: "Firefox", mobile: false });
  });
});

describe("buildVisitorMeta", () => {
  it("combines geo, device, and client meta; seeds the page trail", () => {
    const headers = new Headers({
      "x-vercel-ip-country": "US",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    });
    const meta = buildVisitorMeta({
      headers,
      clientMeta: { page: "https://newcoworker.com/pricing", returning: false }
    });
    expect(meta).toEqual({
      geo: { country: "US" },
      device: { browser: "Chrome", os: "macOS", mobile: false },
      client: { page: "https://newcoworker.com/pricing", returning: false },
      pages: ["https://newcoworker.com/pricing"]
    });
  });

  it("returns null when nothing is collectable; skips empty client meta", () => {
    expect(buildVisitorMeta({ headers: new Headers() })).toBeNull();
    expect(buildVisitorMeta({ headers: new Headers(), clientMeta: {} })).toBeNull();
    // Client meta without a page seeds no trail.
    const h = new Headers({ "x-vercel-ip-country": "CA" });
    expect(buildVisitorMeta({ headers: h, clientMeta: { language: "fr" } })).toEqual({
      geo: { country: "CA" },
      client: { language: "fr" }
    });
  });

  it("compacts undefined-valued keys so all-invalid payloads store nothing", () => {
    // Present-but-invalid fields parse to undefined; the stored client
    // object must not carry them (or exist at all when nothing survived).
    const allInvalid = webchatClientMetaSchema.parse({ screen: "", page: "  " });
    expect(buildVisitorMeta({ headers: new Headers(), clientMeta: allInvalid })).toBeNull();

    const mixed = webchatClientMetaSchema.parse({
      screen: "",
      language: "en",
      utm: { source: "", medium: "cpc" }
    });
    expect(buildVisitorMeta({ headers: new Headers(), clientMeta: mixed })).toEqual({
      client: { language: "en", utm: { medium: "cpc" } }
    });

    // A UTM object whose every field was invalid disappears entirely.
    const emptyUtm = webchatClientMetaSchema.parse({ language: "en", utm: { source: "" } });
    expect(buildVisitorMeta({ headers: new Headers(), clientMeta: emptyUtm })).toEqual({
      client: { language: "en" }
    });
  });
});

describe("parseVisitorMeta", () => {
  it("accepts objects, rejects null/arrays/scalars", () => {
    expect(parseVisitorMeta({ geo: { country: "US" } })).toEqual({ geo: { country: "US" } });
    expect(parseVisitorMeta(null)).toBeNull();
    expect(parseVisitorMeta([1])).toBeNull();
    expect(parseVisitorMeta("x")).toBeNull();
  });
});

describe("appendVisitorPage", () => {
  it("starts a trail on empty meta and truncates the URL", () => {
    const next = appendVisitorPage(null, "https://a.com/" + "x".repeat(600));
    expect(next?.pages).toHaveLength(1);
    expect(next?.pages?.[0]).toHaveLength(VISITOR_META_MAX_URL_CHARS);
  });

  it("dedupes the last entry, ignores blanks, and caps the trail", () => {
    expect(appendVisitorPage({ pages: ["/a"] }, "/a")).toBeNull();
    expect(appendVisitorPage(null, "   ")).toBeNull();
    const full: WebchatVisitorMeta = {
      pages: Array.from({ length: VISITOR_META_MAX_PAGES }, (_, i) => `/p${i}`)
    };
    expect(appendVisitorPage(full, "/new")).toBeNull();
    // Back-and-forth (non-adjacent repeat) still records.
    const next = appendVisitorPage({ pages: ["/a", "/b"] }, "/a");
    expect(next?.pages).toEqual(["/a", "/b", "/a"]);
  });

  it("preserves the rest of the meta object", () => {
    const next = appendVisitorPage({ geo: { country: "US" }, pages: ["/a"] }, "/b");
    expect(next).toEqual({ geo: { country: "US" }, pages: ["/a", "/b"] });
  });
});

describe("display formatting", () => {
  const meta: WebchatVisitorMeta = {
    geo: { city: "Phoenix", region: "AZ", country: "US", timezone: "America/Phoenix" },
    device: { browser: "Chrome", os: "macOS", mobile: false },
    client: {
      page: "https://newcoworker.com/pricing",
      referrer: "https://www.google.com/search",
      utm: { source: "google", medium: "cpc", campaign: "brand" },
      language: "en-US",
      screen: "1440x900",
      timezone: "America/Phoenix",
      returning: true,
      timeOnPageMs: 95_000
    },
    pages: ["https://newcoworker.com/pricing", "https://newcoworker.com/faq"]
  };

  it("formats location, device, and source", () => {
    expect(formatVisitorLocation(meta)).toBe("Phoenix, AZ, US");
    expect(formatVisitorLocation({ geo: {} })).toBeNull();
    expect(formatVisitorLocation(null)).toBeNull();

    expect(formatVisitorDevice(meta)).toBe("Chrome on macOS");
    expect(formatVisitorDevice({ device: { browser: "Safari", mobile: true } })).toBe(
      "Safari · mobile"
    );
    expect(formatVisitorDevice({ device: { os: "iOS", mobile: false } })).toBe("iOS");
    expect(formatVisitorDevice({ device: { mobile: true } })).toBeNull();
    expect(formatVisitorDevice(null)).toBeNull();

    expect(formatVisitorSource(meta)).toBe("google / cpc / brand");
    expect(formatVisitorSource({ client: { referrer: "https://x.com/path" } })).toBe("x.com");
    expect(formatVisitorSource({ client: { referrer: "not a url" } })).toBe("not a url");
    // A parseable referrer with no host (file:) falls back to the raw value.
    expect(formatVisitorSource({ client: { referrer: "file:///tmp/x.html" } })).toBe(
      "file:///tmp/x.html"
    );
    expect(formatVisitorSource({ client: {} })).toBeNull();
    expect(formatVisitorSource(null)).toBeNull();
  });

  it("builds the full display-row set (everything except IP — which is never stored)", () => {
    const rows = visitorMetaDisplayRows(meta);
    expect(rows).toEqual([
      { label: "Location", value: "Phoenix, AZ, US" },
      { label: "Device", value: "Chrome on macOS" },
      { label: "Language", value: "en-US" },
      { label: "Local timezone", value: "America/Phoenix" },
      { label: "Screen", value: "1440x900" },
      { label: "Opened on", value: "https://newcoworker.com/pricing" },
      { label: "Source", value: "google / cpc / brand" },
      { label: "Returning visitor", value: "yes" },
      { label: "Time on page before chat", value: "1m 35s" },
      { label: "Pages visited", value: "https://newcoworker.com/faq" }
    ]);
  });

  it("handles sparse metas: geo timezone fallback, sub-minute durations", () => {
    expect(visitorMetaDisplayRows(null)).toEqual([]);
    const sparse = visitorMetaDisplayRows({
      geo: { timezone: "America/Toronto" },
      client: { returning: false, timeOnPageMs: 12_000 },
      pages: ["https://a.com/only"]
    });
    expect(sparse).toEqual([
      { label: "Local timezone", value: "America/Toronto" },
      { label: "Returning visitor", value: "no" },
      { label: "Time on page before chat", value: "12s" },
      // No client.page to duplicate, so the lone trail entry still shows.
      { label: "Pages visited", value: "https://a.com/only" }
    ]);
    // Client meta without the optional flags/trail emits only what exists.
    expect(visitorMetaDisplayRows({ client: { language: "en" } })).toEqual([
      { label: "Language", value: "en" }
    ]);
  });

  it("dedupes the trail against 'Opened on' but keeps message-time-only trails whole", () => {
    // Trail seeded from client.page: first entry is the "Opened on" page.
    const seeded = visitorMetaDisplayRows({
      client: { page: "https://a.com/start" },
      pages: ["https://a.com/start", "https://a.com/next"]
    });
    expect(seeded).toEqual([
      { label: "Opened on", value: "https://a.com/start" },
      { label: "Pages visited", value: "https://a.com/next" }
    ]);
    // One page, and it IS the opened-on page: no redundant trail row.
    expect(
      visitorMetaDisplayRows({
        client: { page: "https://a.com/start" },
        pages: ["https://a.com/start"]
      })
    ).toEqual([{ label: "Opened on", value: "https://a.com/start" }]);
  });
});
