import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SHORT_CODE_LENGTH,
  deleteShortLinks,
  ensureUrlScheme,
  extractShortenableUrls,
  generateShortCode,
  linkSmsLinksToOutboundLog,
  shortLinkUrl,
  shortenSmsBodyUrls,
  type RandomBytes,
  type ShortLinkSupabase
} from "../supabase/functions/_shared/sms_short_links";

const BASE = "https://www.newcoworker.com";

/** Deterministic byte source: sequential values starting at `start`. */
function bytes(start: number): RandomBytes {
  let n = start;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      out[i] = n;
      n += 1;
    }
    return out;
  };
}

type InsertOutcome = { error: { message: string; code?: string } | null };

function stubDb(outcomes: InsertOutcome[], deleteOutcome: InsertOutcome = { error: null }) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ codes: string[]; row: Record<string, unknown> }> = [];
  const deletes: Array<{ column: string; values: string[] }> = [];
  let call = 0;
  const db: ShortLinkSupabase = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        expect(table).toBe("sms_links");
        inserts.push(row);
        const outcome = outcomes[Math.min(call, outcomes.length - 1)];
        call += 1;
        return Promise.resolve(outcome);
      },
      update: (row: Record<string, unknown>) => ({
        in: (column: string, values: string[]) => {
          expect(table).toBe("sms_links");
          expect(column).toBe("short_code");
          updates.push({ codes: values, row });
          return Promise.resolve({ error: null });
        }
      }),
      delete: () => ({
        in: (column: string, values: string[]) => {
          expect(table).toBe("sms_links");
          deletes.push({ column, values });
          return Promise.resolve(deleteOutcome);
        }
      })
    })
  };
  return { db, inserts, updates, deletes };
}

const ok: InsertOutcome = { error: null };
const collision: InsertOutcome = { error: { message: "duplicate key", code: "23505" } };
const hardError: InsertOutcome = { error: { message: "permission denied", code: "42501" } };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateShortCode", () => {
  it("produces 8 lowercase alphanumerics from the default crypto source", () => {
    const code = generateShortCode();
    expect(code).toHaveLength(SHORT_CODE_LENGTH);
    expect(code).toMatch(/^[a-z0-9]{8}$/);
  });

  it("is deterministic for an injected byte source (mask wraps large bytes)", () => {
    // 0..7 → first 8 alphabet chars; bytes ≥ 32 wrap via the power-of-two mask.
    expect(generateShortCode(bytes(0))).toBe("abcdefgh");
    expect(generateShortCode(bytes(250))).toBe(generateShortCode(bytes(250)));
  });
});

describe("shortLinkUrl", () => {
  it("joins base and code, trimming trailing slashes", () => {
    expect(shortLinkUrl(`${BASE}/`, "abc12345")).toBe(`${BASE}/s/abc12345`);
    expect(shortLinkUrl(BASE, "abc12345")).toBe(`${BASE}/s/abc12345`);
  });
});

describe("extractShortenableUrls", () => {
  const longUrl = "https://calendly.com/d/abc-def/30-minute-meeting?month=2026-08&utm_source=sms";

  it("finds long http(s) URLs and strips trailing sentence punctuation", () => {
    expect(extractShortenableUrls(`Book here: ${longUrl}.`, BASE)).toEqual([longUrl]);
    expect(extractShortenableUrls(`(${longUrl})`, BASE)).toEqual([longUrl]);
  });

  it("keeps a balanced closing paren that belongs to the URL", () => {
    const wiki = "https://en.wikipedia.org/wiki/Phoenix,_Arizona_(disambiguation_page)";
    expect(extractShortenableUrls(`see ${wiki} for info`, BASE)).toEqual([wiki]);
    // Wrapping parens around a paren-carrying URL: only the wrapper falls.
    expect(extractShortenableUrls(`(see ${wiki})`, BASE)).toEqual([wiki]);
    // Punctuation AFTER the balanced paren still falls: "...(bar))." → "(bar)".
    expect(extractShortenableUrls(`Really (${wiki}).`, BASE)).toEqual([wiki]);
  });

  it("skips URLs short enough that shortening would not shrink them", () => {
    expect(extractShortenableUrls("see https://x.co/a for info", BASE)).toEqual([]);
  });

  it("skips our own short links so they are never re-shortened", () => {
    const ours = `${BASE}/s/abc12345`;
    // Padded with a query string so it clears the length floor on its own.
    const oursLong = `${ours}?utm_source=sms&utm_medium=text&utm_campaign=x`;
    expect(extractShortenableUrls(`tap ${oursLong} now`, BASE)).toEqual([]);
  });

  it("dedupes repeats and returns longest-first for safe prefix replacement", () => {
    const shorter = "https://example.com/landing-page-for-the-offer";
    const longer = `${shorter}/with/a/much/deeper/path?ref=sms`;
    const urls = extractShortenableUrls(`${shorter} then ${longer} then ${shorter}`, BASE);
    expect(urls).toEqual([longer, shorter]);
  });

  it("returns [] when there are no URLs at all", () => {
    expect(extractShortenableUrls("plain text, no links", BASE)).toEqual([]);
  });

  const bareUrl = "calendly.com/james-kyp-ads/my-free-scale-plan";

  it("finds bare-domain URLs typed without a scheme", () => {
    expect(extractShortenableUrls(`grab a time here: ${bareUrl}`, BASE)).toEqual([bareUrl]);
    // Trailing sentence punctuation falls the same way as for scheme'd URLs.
    expect(extractShortenableUrls(`Book now: ${bareUrl}.`, BASE)).toEqual([bareUrl]);
    // Case-insensitive on the domain.
    expect(
      extractShortenableUrls("go Calendly.com/james-kyp-ads/my-free-scale-plan now", BASE)
    ).toEqual(["Calendly.com/james-kyp-ads/my-free-scale-plan"]);
  });

  it("does not treat an email's domain as a bare URL", () => {
    expect(extractShortenableUrls(`write john@${bareUrl} today`, BASE)).toEqual([]);
  });

  it("ignores dotted tokens that are not bare URLs", () => {
    // No path ⇒ not a match (also below the length floor by construction).
    expect(extractShortenableUrls("visit example.com for info", BASE)).toEqual([]);
    // Numeric final label (version-like) ⇒ not a match.
    expect(
      extractShortenableUrls("upgraded to 1.2.3/with-a-long-changelog-entry-attached", BASE)
    ).toEqual([]);
    // Mid-path dotted segment of a larger token ⇒ not a match.
    expect(extractShortenableUrls(`see docs/${bareUrl} in the repo`, BASE)).toEqual([]);
    // Malformed scheme ("https:" without "//") ⇒ the host segment must NOT
    // be swapped out from under the stray prefix.
    expect(extractShortenableUrls(`go https:${bareUrl} now`, BASE)).toEqual([]);
  });

  it("skips our own short links even when typed without the scheme or www", () => {
    const query = "?utm_source=sms&utm_medium=text&utm_campaign=x";
    for (const ours of [
      `www.newcoworker.com/s/abc12345${query}`,
      `newcoworker.com/s/abc12345${query}`,
      `https://newcoworker.com/s/abc12345${query}`,
      `HTTPS://WWW.NEWCOWORKER.COM/s/abc12345${query}`
    ]) {
      expect(extractShortenableUrls(`tap ${ours} now`, BASE)).toEqual([]);
    }
  });
});

describe("ensureUrlScheme", () => {
  it("prefixes https:// on bare URLs and leaves scheme'd ones alone", () => {
    expect(ensureUrlScheme("calendly.com/a/b")).toBe("https://calendly.com/a/b");
    expect(ensureUrlScheme("https://calendly.com/a/b")).toBe("https://calendly.com/a/b");
    expect(ensureUrlScheme("HTTP://calendly.com/a/b")).toBe("HTTP://calendly.com/a/b");
  });
});

describe("shortenSmsBodyUrls", () => {
  const longUrl = "https://calendly.com/d/abc-def/30-minute-meeting?month=2026-08&utm_source=sms";
  // NOTE: `bytes(0)` is stateful (sequential counter), so every test mints its
  // own instance to keep codes deterministic per test.
  const staticOpts = {
    businessId: "biz-1",
    source: "ai_flow",
    baseUrl: BASE
  };

  it("no-ops when the base URL is missing or not http(s)", async () => {
    const { db, inserts } = stubDb([ok]);
    for (const baseUrl of [null, undefined, "", "   ", "ftp://x.com"]) {
      const res = await shortenSmsBodyUrls(db, {
        ...staticOpts, randomBytes: bytes(0),
        baseUrl,
        text: `go ${longUrl}`
      });
      expect(res).toEqual({ text: `go ${longUrl}`, links: [] });
    }
    expect(inserts).toHaveLength(0);
  });

  it("replaces a long URL with a tracked short link and persists attribution", async () => {
    const { db, inserts } = stubDb([ok]);
    const res = await shortenSmsBodyUrls(db, {
      ...staticOpts, randomBytes: bytes(0),
      text: `Book here: ${longUrl}.`,
      toE164: "+16025550147",
      flowId: "flow-1",
      runId: "run-1"
    });
    expect(res.links).toEqual([{ shortCode: "abcdefgh", originalUrl: longUrl }]);
    expect(res.text).toBe(`Book here: ${BASE}/s/abcdefgh.`);
    expect(inserts).toEqual([
      {
        business_id: "biz-1",
        short_code: "abcdefgh",
        original_url: longUrl,
        to_e164: "+16025550147",
        source: "ai_flow",
        flow_id: "flow-1",
        run_id: "run-1"
      }
    ]);
  });

  it("shortens a bare-domain URL and stores it scheme-prefixed for the redirect", async () => {
    const bare = "calendly.com/james-kyp-ads/my-free-scale-plan";
    const { db, inserts } = stubDb([ok]);
    const res = await shortenSmsBodyUrls(db, {
      ...staticOpts, randomBytes: bytes(0),
      text: `You can grab a time here: ${bare}`
    });
    expect(res.text).toBe(`You can grab a time here: ${BASE}/s/abcdefgh`);
    expect(res.links).toEqual([{ shortCode: "abcdefgh", originalUrl: bare }]);
    expect(inserts[0]).toMatchObject({ original_url: `https://${bare}` });
  });

  it("defaults recipient/flow/run attribution to null when omitted", async () => {
    const { db, inserts } = stubDb([ok]);
    await shortenSmsBodyUrls(db, { ...staticOpts, randomBytes: bytes(0), text: longUrl });
    expect(inserts[0]).toMatchObject({ to_e164: null, flow_id: null, run_id: null });
  });

  it("replaces every occurrence of a repeated URL with one shared code", async () => {
    const { db, inserts } = stubDb([ok]);
    const res = await shortenSmsBodyUrls(db, {
      ...staticOpts, randomBytes: bytes(0),
      text: `${longUrl} and again ${longUrl}`
    });
    expect(inserts).toHaveLength(1);
    expect(res.text).toBe(`${BASE}/s/abcdefgh and again ${BASE}/s/abcdefgh`);
  });

  it("replaces prefix-overlapping URLs without corrupting the longer one", async () => {
    const { db } = stubDb([ok]);
    const shorter = "https://example.com/landing-page-for-the-offer";
    const longer = `${shorter}/with/a/much/deeper/path?ref=sms`;
    const res = await shortenSmsBodyUrls(db, {
      ...staticOpts, randomBytes: bytes(0),
      text: `${shorter} vs ${longer}`
    });
    // Longest-first: bytes(0) mints "abcdefgh" for the longer URL, then the
    // next sequential window for the shorter.
    expect(res.links).toHaveLength(2);
    expect(res.links[0].originalUrl).toBe(longer);
    expect(res.text).toContain(`${BASE}/s/abcdefgh`);
    expect(res.text).not.toContain("landing-page-for-the-offer");
  });

  it("leaves the URL untouched on a non-collision insert error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db } = stubDb([hardError]);
    const res = await shortenSmsBodyUrls(db, { ...staticOpts, randomBytes: bytes(0), text: `go ${longUrl}` });
    expect(res).toEqual({ text: `go ${longUrl}`, links: [] });
    expect(warn).toHaveBeenCalledWith(
      "sms_short_links: insert failed, leaving URL unshortened",
      "permission denied"
    );
  });

  it("retries a fresh code on unique collision and succeeds", async () => {
    const { db, inserts } = stubDb([collision, ok]);
    const res = await shortenSmsBodyUrls(db, { ...staticOpts, randomBytes: bytes(0), text: longUrl });
    expect(inserts).toHaveLength(2);
    expect(inserts[0].short_code).not.toBe(inserts[1].short_code);
    expect(res.links).toHaveLength(1);
    expect(res.links[0].shortCode).toBe(inserts[1].short_code);
  });

  it("gives up after exhausting collision retries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db, inserts } = stubDb([collision, collision, collision]);
    const res = await shortenSmsBodyUrls(db, { ...staticOpts, randomBytes: bytes(0), text: longUrl });
    expect(inserts).toHaveLength(3);
    expect(res).toEqual({ text: longUrl, links: [] });
    expect(warn).toHaveBeenCalledWith(
      "sms_short_links: exhausted code attempts, leaving URL unshortened"
    );
  });

  it("leaves the URL untouched when the insert throws (Error and non-Error)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const thrown of [new Error("network down"), "string failure"]) {
      const db: ShortLinkSupabase = {
        from: () => ({
          insert: () => Promise.reject(thrown),
          update: () => ({ in: () => Promise.resolve({ error: null }) }),
          delete: () => ({ in: () => Promise.resolve({ error: null }) })
        })
      };
      const res = await shortenSmsBodyUrls(db, { ...staticOpts, randomBytes: bytes(0), text: longUrl });
      expect(res).toEqual({ text: longUrl, links: [] });
    }
    expect(warn).toHaveBeenCalledWith(
      "sms_short_links: insert threw, leaving URL unshortened",
      "network down"
    );
    expect(warn).toHaveBeenCalledWith(
      "sms_short_links: insert threw, leaving URL unshortened",
      "string failure"
    );
  });

  it("returns the text unchanged when nothing is shortenable", async () => {
    const { db, inserts } = stubDb([ok]);
    const res = await shortenSmsBodyUrls(db, { ...staticOpts, randomBytes: bytes(0), text: "no links here" });
    expect(res).toEqual({ text: "no links here", links: [] });
    expect(inserts).toHaveLength(0);
  });
});

describe("linkSmsLinksToOutboundLog", () => {
  it("updates short codes with the outbound log id", async () => {
    const { db, updates } = stubDb([ok]);
    await linkSmsLinksToOutboundLog(db, ["abc12345", "ijklmnop"], "log-1");
    expect(updates).toEqual([
      { codes: ["abc12345", "ijklmnop"], row: { sms_outbound_log_id: "log-1" } }
    ]);
  });

  it("no-ops on empty codes or missing log id", async () => {
    const { db, updates } = stubDb([ok]);
    await linkSmsLinksToOutboundLog(db, [], "log-1");
    await linkSmsLinksToOutboundLog(db, ["abc12345"], null);
    expect(updates).toHaveLength(0);
  });

  it("warns on update errors and thrown failures without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db: errDb } = stubDb([ok]);
    errDb.from = () => ({
      insert: () => Promise.resolve({ error: null }),
      update: () => ({
        in: () => Promise.resolve({ error: { message: "denied" } })
      }),
      delete: () => ({ in: () => Promise.resolve({ error: null }) })
    });
    await linkSmsLinksToOutboundLog(errDb, ["abc12345"], "log-1");
    expect(warn).toHaveBeenCalledWith("sms_short_links: outbound log pairing failed", "denied");

    for (const thrown of [new Error("net down"), "string failure"]) {
      const throwing: ShortLinkSupabase = {
        from: () => ({
          insert: () => Promise.resolve({ error: null }),
          update: () => ({ in: () => Promise.reject(thrown) }),
          delete: () => ({ in: () => Promise.resolve({ error: null }) })
        })
      };
      await linkSmsLinksToOutboundLog(throwing, ["abc12345"], "log-1");
    }
    expect(warn).toHaveBeenCalledWith("sms_short_links: outbound log pairing threw", "net down");
    expect(warn).toHaveBeenCalledWith(
      "sms_short_links: outbound log pairing threw",
      "string failure"
    );
  });
});

describe("deleteShortLinks", () => {
  const links = [
    { shortCode: "abcdefgh", originalUrl: "https://x.co/1" },
    { shortCode: "ijklmnop", originalUrl: "https://x.co/2" }
  ];

  it("deletes the given codes and no-ops on an empty list", async () => {
    const { db, deletes } = stubDb([ok]);
    await deleteShortLinks(db, links);
    expect(deletes).toEqual([{ column: "short_code", values: ["abcdefgh", "ijklmnop"] }]);

    const { db: db2, deletes: deletes2 } = stubDb([ok]);
    await deleteShortLinks(db2, []);
    expect(deletes2).toHaveLength(0);
  });

  it("never throws: delete errors and thrown failures only warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db } = stubDb([ok], { error: { message: "denied" } });
    await deleteShortLinks(db, links);
    expect(warn).toHaveBeenCalledWith("sms_short_links: cleanup delete failed", "denied");

    for (const thrown of [new Error("net down"), "string failure"]) {
      const throwing: ShortLinkSupabase = {
        from: () => ({
          insert: () => Promise.resolve({ error: null }),
          update: () => ({ in: () => Promise.resolve({ error: null }) }),
          delete: () => ({ in: () => Promise.reject(thrown) })
        })
      };
      await deleteShortLinks(throwing, links);
    }
    expect(warn).toHaveBeenCalledWith("sms_short_links: cleanup delete threw", "net down");
    expect(warn).toHaveBeenCalledWith("sms_short_links: cleanup delete threw", "string failure");
  });
});
