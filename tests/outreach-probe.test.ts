/**
 * Prospecting site probe (src/lib/outreach/probe.ts): the findings are only
 * ever ABSENCES of a capability marker, the address ranking prefers the
 * prospect's own role mailbox, and every read failure degrades to "not
 * reachable" instead of throwing.
 */
import { describe, expect, it, vi } from "vitest";

import {
  detectFindings,
  extractEmails,
  hoursFindings,
  mergeHoursFindings,
  PROBE_MAX_BYTES,
  PROBE_TIMEOUT_MS,
  probeSite
} from "@/lib/outreach/probe";

/** A page that has every capability, so it yields no findings at all. */
const FULLY_EQUIPPED = `
  <a href="tel:+16025550100">call</a>
  <a href="sms:+16025550100">text us</a>
  <a href="https://calendly.com/acme/30min">book now</a>
  <script src="https://widget.intercom.io/widget/abc"></script>
  <p>open 24 hours, every day</p>
`.toLowerCase();

function htmlResponse(body: string, ok = true) {
  return { ok, text: async () => body } as unknown as Response;
}

describe("detectFindings", () => {
  it("finds nothing on a site that already does all of it", () => {
    expect(detectFindings(FULLY_EQUIPPED)).toEqual([]);
  });

  it("reports each missing capability with the evidence behind it", () => {
    const codes = detectFindings("<p>we are a plumbing company</p>").map((f) => f.code);
    expect(codes).toEqual([
      "no_online_booking",
      "no_chat_widget",
      "no_text_option",
      "no_tap_to_call"
    ]);
    // Every finding carries a detail: the pitch may only say what is here.
    expect(detectFindings("<p>hi</p>").every((f) => f.detail.length > 0)).toBe(true);
  });

  it("quotes the weekend-closed line it matched", () => {
    const findings = detectFindings(`${FULLY_EQUIPPED} <p>closed on weekends</p>`);
    expect(findings).toEqual([
      { code: "closed_weekends", detail: expect.stringContaining("closed on weekends") }
    ]);
  });

  it("reports an after-hours gap only when the posted close is early", () => {
    const early = detectFindings(`${FULLY_EQUIPPED} <p>mon - fri 8:00 am - 5:00 pm</p>`);
    expect(early).toEqual([
      { code: "after_hours_gap", detail: expect.stringContaining("8:00 am - 5:00 pm") }
    ]);

    // Open until 8pm: no gap worth mentioning, so nothing is claimed.
    expect(detectFindings(`${FULLY_EQUIPPED} <p>mon to fri 8 am to 8 pm</p>`)).toEqual([]);
    // An en dash separator is the same claim.
    expect(
      detectFindings(`${FULLY_EQUIPPED} <p>mon \u2013 fri 9:00 am \u2013 4:30 pm</p>`).map(
        (f) => f.code
      )
    ).toEqual(["after_hours_gap"]);
  });
});

describe("hoursFindings", () => {
  /** Google's shape: one period per open day, 0 = Sunday. */
  const weekday = (day: number, openHour: number, closeHour: number) => ({
    open: { day, hour: openHour, minute: 0 },
    close: { day, hour: closeHour, minute: 0 }
  });
  const monToFri = (closeHour: number) => [1, 2, 3, 4, 5].map((d) => weekday(d, 8, closeHour));

  it("finds nothing to fall back on when Google holds no hours", () => {
    // Null is the signal to use the site's markup instead.
    expect(hoursFindings(null)).toBeNull();
    expect(hoursFindings({})).toBeNull();
    expect(hoursFindings({ periods: [] })).toBeNull();
  });

  it("reports a weekend closure when no period opens on Saturday or Sunday", () => {
    expect(hoursFindings({ periods: monToFri(17) })).toEqual([
      { code: "closed_weekends", detail: expect.stringContaining("closed on Saturday and Sunday") },
      { code: "after_hours_gap", detail: expect.stringContaining("5 PM") }
    ]);

    // Open Saturday: no weekend claim, and the weekday gap still stands.
    const withSaturday = { periods: [...monToFri(17), weekday(6, 9, 13)] };
    expect(hoursFindings(withSaturday)?.map((f) => f.code)).toEqual(["after_hours_gap"]);
  });

  it("reports an after-hours gap only when the weekday close is early", () => {
    expect(hoursFindings({ periods: monToFri(18) })?.map((f) => f.code)).toContain(
      "after_hours_gap"
    );
    // Open until 8pm: nothing worth claiming about after-hours calls.
    expect(hoursFindings({ periods: monToFri(20) })?.map((f) => f.code)).toEqual([
      "closed_weekends"
    ]);
  });

  it("claims NOTHING about a business that never closes", () => {
    // Google reports "always open" as a period with no close. Reading the rest
    // as a weekly schedule would invent a weekend closure for a business that
    // never shuts, and an after-hours gap out of a missing closing time.
    const alwaysOpen = { periods: [{ open: { day: 1, hour: 0, minute: 0 } }] };
    expect(hoursFindings(alwaysOpen)).toEqual([]);
    // One open-ended period poisons the whole schedule, not just its own day.
    expect(hoursFindings({ periods: [...monToFri(17), { open: { day: 3, hour: 0 } }] })).toEqual(
      []
    );
  });

  it("claims NOTHING when a period runs past midnight", () => {
    // Friday 6 PM to Saturday 2 AM arrives as close.hour 2. Reading that as the
    // closing time would tell a bar open until 2 in the morning that it shuts
    // too early, and it is also open on Saturday, so the weekend claim is wrong.
    const lateNight = {
      periods: [
        ...monToFri(17),
        { open: { day: 5, hour: 18, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } }
      ]
    };
    expect(hoursFindings(lateNight)).toEqual([]);

    // An empty list is NOT the same as null: Google had hours, so the markup
    // regex does not get a second guess at the same question.
    expect(mergeHoursFindings([{ code: "after_hours_gap", detail: "markup" }], [])).toEqual([]);
  });

  it("ignores periods with no usable day, and weekend closing times", () => {
    // A malformed period contributes nothing rather than throwing.
    expect(hoursFindings({ periods: [{ close: { day: 2, hour: 17 } }] })).toEqual([]);
    // A Saturday close must not be read as the weekday closing time.
    const saturdayOnly = { periods: [weekday(6, 9, 13)] };
    expect(saturdayOnly.periods.length).toBe(1);
    expect(hoursFindings(saturdayOnly)).toEqual([]);
  });

  it("phrases the hour in words, and never emits a dash character", () => {
    const detail = hoursFindings({ periods: monToFri(12) })?.[1]?.detail ?? "";
    // Noon reads as 12 PM, not 0 PM.
    expect(detail).toContain("12 PM");
    // Google's own weekdayDescriptions carry a dash we are not allowed to emit,
    // which is why the sentence is built from the numbers instead.
    expect(detail).not.toContain("\u2014");
    expect(detail).not.toContain("\u2013");
    const morning = hoursFindings({ periods: [weekday(1, 6, 11)] })?.[1]?.detail ?? "";
    expect(morning).toContain("11 AM");
  });
});

describe("mergeHoursFindings", () => {
  const site = [
    { code: "no_online_booking", detail: "site" },
    { code: "after_hours_gap", detail: "from the markup" },
    { code: "closed_weekends", detail: "from the markup" }
  ];

  it("keeps the site's findings when Google has no hours", () => {
    expect(mergeHoursFindings(site, null)).toEqual(site);
  });

  it("substitutes ONLY the hours findings, never the site-only ones", () => {
    const merged = mergeHoursFindings(site, [{ code: "after_hours_gap", detail: "from Google" }]);
    expect(merged).toEqual([
      { code: "no_online_booking", detail: "site" },
      { code: "after_hours_gap", detail: "from Google" }
    ]);
  });

  it("drops a markup hours claim Google contradicts", () => {
    // Google has hours and reports no gap: the regex's guess does not survive.
    expect(mergeHoursFindings(site, [])).toEqual([{ code: "no_online_booking", detail: "site" }]);
  });
});

describe("extractEmails", () => {
  it("prefers the prospect's own role mailbox over anything else", () => {
    const html = `
      contact brian.personal@gmail.com or info@acme.com or someone@acme.com
      or hello@partner.com
    `.toLowerCase();
    expect(extractEmails(html, "acme.com")[0]).toBe("info@acme.com");
    // Own-domain beats a third-party role mailbox.
    expect(extractEmails("someone@acme.com hello@partner.com", "acme.com")[0]).toBe(
      "someone@acme.com"
    );
    // A subdomain of the prospect still counts as their own.
    expect(extractEmails("info@mail.acme.com other@x.com", "acme.com")[0]).toBe(
      "info@mail.acme.com"
    );
  });

  it("drops platform boilerplate, no-reply senders, asset filenames, and duplicates", () => {
    const html = `
      no-reply@acme.com donotreply@acme.com someone@example.com
      logo@2x.png sprite@3x.jpeg real@acme.com real@acme.com
    `.toLowerCase();
    expect(extractEmails(html, "acme.com")).toEqual(["real@acme.com"]);
    expect(extractEmails("nothing here", "acme.com")).toEqual([]);
  });

  it("never reads a Sentry DSN or another machine key as a contact address", () => {
    // The live miss: a Wix site's page JavaScript carries its Sentry DSN
    // (`https://<32-hex-key>@sentry.wixpress.com/<id>`), the key@host half
    // matches the address regex, and the pitch to it bounced (2026-08-27,
    // sunlandautomesa.com). wixpress.com is Wix's internal domain and
    // `@sentry.` covers self-hosted Sentry on any host.
    const dsn = "dd0a55ccb8124b9c9d938e3acf41f8aa@sentry.wixpress.com";
    expect(extractEmails(`${dsn} real@acme.com`, "acme.com")).toEqual(["real@acme.com"]);
    expect(extractEmails("abc123@sentry.acme.com", "acme.com")).toEqual([]);
    // A long hex localpart is a credential even on an otherwise clean host,
    // and even on the prospect's own domain.
    expect(extractEmails("deadbeefdeadbeefdead@tracking.acme.com", "acme.com")).toEqual([]);
    // A short hex-looking mailbox is still a plausible human address.
    expect(extractEmails("abc123@acme.com", "acme.com")).toEqual(["abc123@acme.com"]);
  });
});

describe("probeSite", () => {
  it("returns findings and the best address from the homepage", async () => {
    const fetchImpl = vi.fn(async () =>
      htmlResponse("<p>call us</p> info@acme.com")
    ) as unknown as typeof fetch;
    const result = await probeSite("https://acme.com", "acme.com", { fetchImpl });
    expect(result.reachable).toBe(true);
    expect(result.email).toBe("info@acme.com");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("tries one conventional contact path when the homepage publishes no address", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      htmlResponse(String(url).includes("/contact") ? "hello@acme.com" : "<p>no address</p>")
    ) as unknown as typeof fetch;
    const result = await probeSite("https://acme.com/", "acme.com", { fetchImpl });
    expect(result.email).toBe("hello@acme.com");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe(
      "https://acme.com/contact"
    );
  });

  it("gives up on an address when neither page has one", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse("<p>nothing</p>")) as unknown as typeof fetch;
    const result = await probeSite("https://acme.com", "acme.com", { fetchImpl });
    expect(result.email).toBeNull();
    expect(result.reachable).toBe(true);
  });

  it("keeps the findings when the contact page itself is unreadable", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/contact")
        ? htmlResponse("nope", false)
        : htmlResponse("<p>homepage</p>")
    ) as unknown as typeof fetch;
    const result = await probeSite("https://acme.com", "acme.com", { fetchImpl });
    expect(result.reachable).toBe(true);
    expect(result.email).toBeNull();
  });

  it("reports an unreadable site instead of throwing", async () => {
    const refused = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await probeSite("https://acme.com", "acme.com", { fetchImpl: refused })).toEqual({
      findings: [],
      email: null,
      reachable: false,
      failure: "site unreadable"
    });

    const notFound = vi.fn(async () => htmlResponse("missing", false)) as unknown as typeof fetch;
    expect(
      (await probeSite("https://acme.com", "acme.com", { fetchImpl: notFound })).reachable
    ).toBe(false);
  });

  /**
   * Doubles as the backtracking regression: an unbounded local part in the
   * address regex turns a long run of word characters (any minified script)
   * into quadratic backtracking, which hung this test outright. If the bounds
   * in extractEmails are ever loosened, this test stops finishing.
   */
  it("caps the body it reads and identifies itself honestly", async () => {
    const huge = `${"x".repeat(PROBE_MAX_BYTES + 500)}info@acme.com`;
    const fetchImpl = vi.fn(async () => htmlResponse(huge)) as unknown as typeof fetch;
    // The address sits past the cap, so it is not found: the cap is real.
    const result = await probeSite("https://acme.com", "acme.com", { fetchImpl });
    expect(result.email).toBeNull();
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as { headers: Record<string, string> })["headers"]["User-Agent"]).toMatch(
      /NewCoworkerProspectBot/
    );
  });

  it("aborts a page read that outlasts the timeout, so one slow site cannot stall the pass", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        })
    ) as unknown as typeof fetch;
    const pending = probeSite("https://slow.example", "slow.example", { fetchImpl });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ reachable: false, failure: "site unreadable" });
    vi.useRealTimers();
  });

  it("defaults to the global fetch when no impl is injected", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(htmlResponse("<p>page</p> info@acme.com"));
    expect((await probeSite("https://acme.com", "acme.com")).email).toBe("info@acme.com");
    spy.mockRestore();
  });
});
