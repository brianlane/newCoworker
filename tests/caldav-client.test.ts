import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import {
  CALDAV_MAX_REDIRECTS,
  CaldavApiError,
  assertSafeCaldavUrl,
  caldavRequest,
  createCaldavEvent,
  deleteCaldavEvent,
  discoverEventCalendars,
  escapeICalText,
  extractCalendarData,
  extractHrefInside,
  fetchCaldavBusy,
  icalUtcStamp,
  parseCalendarList,
  parseICalBusyBlocks,
  parseICalDateValue,
  pickPreferredCalendar,
  stripXmlNamespaces,
  unfoldICalLines,
  updateCaldavEventTime,
  verifyCaldavConnection
} from "@/lib/caldav/client";

const CREDS = {
  serverUrl: "https://caldav.icloud.com",
  username: "owner@icloud.com",
  password: "app-pass"
};

type FakeResponse = {
  status: number;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
};

function response(
  status: number,
  body = "",
  headers: Record<string, string> = {}
): FakeResponse {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body
  };
}

function fetchSequence(responses: FakeResponse[]) {
  let i = 0;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return res as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("assertSafeCaldavUrl", () => {
  it("accepts public https URLs", () => {
    expect(assertSafeCaldavUrl("https://caldav.icloud.com/x").hostname).toBe(
      "caldav.icloud.com"
    );
  });
  it("rejects malformed, non-https, and private URLs", () => {
    expect(() => assertSafeCaldavUrl("nope")).toThrow(CaldavApiError);
    expect(() => assertSafeCaldavUrl("http://caldav.example.com")).toThrow(/https/);
    expect(() => assertSafeCaldavUrl("https://127.0.0.1/dav")).toThrow(/private/);
  });
});

describe("caldavRequest", () => {
  it("sends basic auth and returns the body", async () => {
    const { impl, calls } = fetchSequence([response(207, "<xml/>")]);
    const res = await caldavRequest(
      CREDS,
      { url: "https://caldav.icloud.com/", method: "PROPFIND" },
      { fetchImpl: impl }
    );
    expect(res).toEqual({ status: 207, body: "<xml/>" });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("owner@icloud.com:app-pass").toString("base64")}`
    );
    // No body key when the request carries none.
    expect(calls[0].init).not.toHaveProperty("body");
  });

  it("follows re-validated relative redirects", async () => {
    const { impl, calls } = fetchSequence([
      response(301, "", { location: "/123/principal/" }),
      response(200, "done")
    ]);
    const res = await caldavRequest(
      CREDS,
      { url: "https://caldav.icloud.com/", method: "PROPFIND", body: "b" },
      { fetchImpl: impl }
    );
    expect(res.body).toBe("done");
    expect(calls[1].url).toBe("https://caldav.icloud.com/123/principal/");
  });

  it("refuses a redirect to a private host", async () => {
    const { impl } = fetchSequence([
      response(302, "", { location: "https://192.168.0.1/steal" })
    ]);
    await expect(
      caldavRequest(CREDS, { url: "https://caldav.icloud.com/", method: "GET" }, { fetchImpl: impl })
    ).rejects.toMatchObject({ code: "blocked_url" });
  });

  it("fails on a redirect without a Location header", async () => {
    const { impl } = fetchSequence([response(301)]);
    await expect(
      caldavRequest(CREDS, { url: "https://caldav.icloud.com/", method: "GET" }, { fetchImpl: impl })
    ).rejects.toMatchObject({ code: "request_failed" });
  });

  it("gives up after the redirect budget", async () => {
    const { impl, calls } = fetchSequence([
      response(301, "", { location: "https://caldav.icloud.com/loop" })
    ]);
    await expect(
      caldavRequest(CREDS, { url: "https://caldav.icloud.com/", method: "GET" }, { fetchImpl: impl })
    ).rejects.toMatchObject({ code: "request_failed" });
    expect(calls).toHaveLength(CALDAV_MAX_REDIRECTS + 1);
  });

  it("maps 401/403 to auth_failed", async () => {
    for (const status of [401, 403]) {
      const { impl } = fetchSequence([response(status)]);
      await expect(
        caldavRequest(CREDS, { url: "https://caldav.icloud.com/", method: "GET" }, { fetchImpl: impl })
      ).rejects.toMatchObject({ code: "auth_failed", status });
    }
  });

  it("falls back to global fetch when no fetchImpl is injected", async () => {
    const { impl } = fetchSequence([response(200, "global")]);
    vi.stubGlobal("fetch", impl);
    try {
      const res = await caldavRequest(CREDS, {
        url: "https://caldav.icloud.com/",
        method: "GET"
      });
      expect(res).toEqual({ status: 200, body: "global" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("aborts a hung request at the timeout", async () => {
    vi.useFakeTimers();
    try {
      const hung = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      ) as unknown as typeof fetch;
      const pending = caldavRequest(
        CREDS,
        { url: "https://caldav.icloud.com/", method: "GET" },
        { fetchImpl: hung }
      );
      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(21_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps aborts to upstream_timeout and other network errors to upstream_unreachable", async () => {
    const abort = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    await expect(
      caldavRequest(CREDS, { url: "https://caldav.icloud.com/", method: "GET" }, { fetchImpl: abort })
    ).rejects.toMatchObject({ code: "upstream_timeout" });

    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      caldavRequest(CREDS, { url: "https://caldav.icloud.com/", method: "GET" }, { fetchImpl: down })
    ).rejects.toMatchObject({ code: "upstream_unreachable" });
  });
});

describe("XML helpers", () => {
  it("stripXmlNamespaces removes tag prefixes only", () => {
    expect(stripXmlNamespaces("<D:href>/a:b</D:href><C:x/></C:x>")).toBe(
      "<href>/a:b</href><x/></x>"
    );
  });

  it("extractHrefInside finds the first href in the named element", () => {
    const xml =
      '<D:multistatus xmlns:D="DAV:"><D:current-user-principal>' +
      "<D:href>/123/principal/</D:href></D:current-user-principal></D:multistatus>";
    expect(extractHrefInside(xml, "current-user-principal")).toBe("/123/principal/");
    expect(extractHrefInside(xml, "calendar-home-set")).toBeNull();
    expect(extractHrefInside("<current-user-principal></current-user-principal>", "current-user-principal")).toBeNull();
  });

  it("parseCalendarList keeps only event-capable calendar collections", () => {
    const xml = `
      <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
        <D:response>
          <D:href>/cals/</D:href>
          <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
        </D:response>
        <D:response>
          <D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype></D:prop></D:propstat>
        </D:response>
        <D:response>
          <D:href>/cals/work/</D:href>
          <D:propstat><D:prop>
            <D:displayname>Work</D:displayname>
            <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
            <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
          </D:prop></D:propstat>
        </D:response>
        <D:response>
          <D:href>/cals/reminders/</D:href>
          <D:propstat><D:prop>
            <D:displayname>Reminders</D:displayname>
            <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
            <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
          </D:prop></D:propstat>
        </D:response>
        <D:response>
          <D:href>https://p42.example.com/cals/unnamed/</D:href>
          <D:propstat><D:prop>
            <D:displayname></D:displayname>
            <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
          </D:prop></D:propstat>
        </D:response>
      </D:multistatus>`;
    const calendars = parseCalendarList(xml, "https://caldav.icloud.com/cals/");
    expect(calendars).toEqual([
      { url: "https://caldav.icloud.com/cals/work/", name: "Work" },
      { url: "https://p42.example.com/cals/unnamed/", name: "Calendar" }
    ]);
  });

  it("pickPreferredCalendar prefers the name heuristic and falls back to first", () => {
    expect(pickPreferredCalendar([])).toBeNull();
    expect(
      pickPreferredCalendar([
        { url: "u1", name: "Family" },
        { url: "u2", name: "Work" }
      ])?.url
    ).toBe("u2");
    expect(
      pickPreferredCalendar([
        { url: "u1", name: "Family" },
        { url: "u2", name: "Side gigs" }
      ])?.url
    ).toBe("u1");
  });
});

describe("iCal helpers", () => {
  it("unfoldICalLines undoes CRLF and LF folding", () => {
    expect(unfoldICalLines("SUMMARY:He\r\n llo\r\nX:1\n\ty")).toEqual(["SUMMARY:Hello", "X:1y"]);
  });

  it("icalUtcStamp formats an instant", () => {
    expect(icalUtcStamp(new Date("2026-07-11T09:30:15.123Z"))).toBe("20260711T093015Z");
  });

  it("parseICalDateValue handles datetime, date-only, and garbage", () => {
    expect(parseICalDateValue("20260711T090000Z")?.toISOString()).toBe(
      "2026-07-11T09:00:00.000Z"
    );
    expect(parseICalDateValue("20260711T090000")?.toISOString()).toBe(
      "2026-07-11T09:00:00.000Z"
    );
    expect(parseICalDateValue("20260711")?.toISOString()).toBe("2026-07-11T00:00:00.000Z");
    expect(parseICalDateValue("garbage")).toBeNull();
  });

  it("parseICalBusyBlocks extracts events and skips cancelled/transparent/incomplete ones", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "DTSTART:19700101T000000Z", // outside any VEVENT — ignored
      "BEGIN:VEVENT",
      "UID:1",
      "DTSTART:20260711T090000Z",
      "DTEND:20260711T100000Z",
      "SUMMARY:Keep",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:2",
      "STATUS:CANCELLED",
      "DTSTART:20260711T110000Z",
      "DTEND:20260711T120000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:3",
      "TRANSP:TRANSPARENT",
      "DTSTART:20260711T130000Z",
      "DTEND:20260711T140000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:4",
      "DTSTART:20260711T150000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:5",
      "DTSTART:20260711T160000Z",
      "DTEND:20260711T160000Z", // zero length — skipped
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:6",
      "DTSTART;TZID=America/Phoenix:garbage", // unparseable value — skipped
      "DTEND:20260711T180000Z",
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");
    expect(parseICalBusyBlocks(ical)).toEqual([
      {
        start: new Date("2026-07-11T09:00:00.000Z"),
        end: new Date("2026-07-11T10:00:00.000Z")
      }
    ]);
  });

  it("parseICalBusyBlocks keeps STATUS/TRANSP values that are not skip-worthy", () => {
    const ical = [
      "BEGIN:VEVENT",
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "DTSTART;VALUE=DATE:20260711",
      "DTEND;VALUE=DATE:20260712",
      "END:VEVENT"
    ].join("\n");
    expect(parseICalBusyBlocks(ical)).toHaveLength(1);
  });

  it("extractCalendarData handles plain, CDATA, and escaped payloads", () => {
    const xml =
      "<multistatus>" +
      "<C:calendar-data>BEGIN:VCALENDAR&#13;\nX:a &amp; b &lt;c&gt; &quot;d&quot;</C:calendar-data>" +
      "<calendar-data><![CDATA[BEGIN:VCALENDAR\nY:2]]></calendar-data>" +
      "</multistatus>";
    const payloads = extractCalendarData(xml);
    expect(payloads[0]).toBe('BEGIN:VCALENDAR\r\nX:a & b <c> "d"');
    expect(payloads[1]).toBe("BEGIN:VCALENDAR\nY:2");
  });

  it("escapeICalText escapes RFC 5545 specials", () => {
    expect(escapeICalText("a\\b;c,d\ne\r\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
  });
});

const PRINCIPAL_XML =
  '<D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop>' +
  "<D:current-user-principal><D:href>/123/principal/</D:href></D:current-user-principal>" +
  "</D:prop></D:propstat></D:response></D:multistatus>";

const HOME_XML =
  '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
  "<D:response><D:propstat><D:prop>" +
  "<C:calendar-home-set><D:href>https://p42-caldav.icloud.com/123/calendars/</D:href></C:calendar-home-set>" +
  "</D:prop></D:propstat></D:response></D:multistatus>";

const LIST_XML =
  '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
  "<D:response><D:href>/123/calendars/home/</D:href><D:propstat><D:prop>" +
  "<D:displayname>Home</D:displayname>" +
  "<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>" +
  '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>' +
  "</D:prop></D:propstat></D:response></D:multistatus>";

describe("discoverEventCalendars", () => {
  it("walks principal → home → calendar list", async () => {
    const { impl, calls } = fetchSequence([
      response(207, PRINCIPAL_XML),
      response(207, HOME_XML),
      response(207, LIST_XML)
    ]);
    const calendars = await discoverEventCalendars(CREDS, { fetchImpl: impl });
    expect(calendars).toEqual([
      { url: "https://p42-caldav.icloud.com/123/calendars/home/", name: "Home" }
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://caldav.icloud.com/",
      "https://caldav.icloud.com/123/principal/",
      "https://p42-caldav.icloud.com/123/calendars/"
    ]);
    const depths = calls.map((c) => (c.init.headers as Record<string, string>).Depth);
    expect(depths).toEqual(["0", "0", "1"]);
  });

  it("fails when the principal or home href is missing", async () => {
    const noPrincipal = fetchSequence([response(207, "<multistatus/>")]);
    await expect(
      discoverEventCalendars(CREDS, { fetchImpl: noPrincipal.impl })
    ).rejects.toThrow(/principal discovery/);

    const noHome = fetchSequence([
      response(207, PRINCIPAL_XML),
      response(207, "<multistatus/>")
    ]);
    await expect(discoverEventCalendars(CREDS, { fetchImpl: noHome.impl })).rejects.toThrow(
      /calendar-home-set/
    );
  });

  it("fails on a non-2xx PROPFIND", async () => {
    const { impl } = fetchSequence([response(500, "boom")]);
    await expect(discoverEventCalendars(CREDS, { fetchImpl: impl })).rejects.toMatchObject({
      code: "request_failed",
      status: 500
    });
  });
});

describe("fetchCaldavBusy", () => {
  const CAL_URL = "https://p42-caldav.icloud.com/123/calendars/home/";

  it("REPORTs the window with expand and parses busy blocks", async () => {
    const report =
      "<multistatus><response><calendar-data>" +
      "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\n" +
      "DTSTART:20260711T090000Z\nDTEND:20260711T100000Z\nEND:VEVENT\nEND:VCALENDAR" +
      "</calendar-data></response></multistatus>";
    const { impl, calls } = fetchSequence([response(207, report)]);
    const busy = await fetchCaldavBusy(
      CREDS,
      CAL_URL,
      new Date("2026-07-11T00:00:00Z"),
      new Date("2026-07-12T00:00:00Z"),
      { fetchImpl: impl }
    );
    expect(busy).toEqual([
      {
        start: new Date("2026-07-11T09:00:00.000Z"),
        end: new Date("2026-07-11T10:00:00.000Z")
      }
    ]);
    expect(calls[0].init.method).toBe("REPORT");
    const body = calls[0].init.body as string;
    expect(body).toContain('<C:expand start="20260711T000000Z" end="20260712T000000Z"/>');
    expect(body).toContain('<C:time-range start="20260711T000000Z" end="20260712T000000Z"/>');
  });

  it("throws on a non-2xx REPORT", async () => {
    const { impl } = fetchSequence([response(400, "bad")]);
    await expect(
      fetchCaldavBusy(CREDS, CAL_URL, new Date(), new Date(), { fetchImpl: impl })
    ).rejects.toMatchObject({ code: "request_failed", status: 400 });
  });
});

describe("createCaldavEvent", () => {
  const CAL_URL = "https://p42-caldav.icloud.com/123/calendars/home/";
  const EVENT = {
    uid: "newcoworker-abc-123",
    summary: "Consult; with Amy",
    description: "Attendee: Amy\nPhone: +16025550147",
    startIso: "2026-07-14T16:00:00.000Z",
    endIso: "2026-07-14T16:30:00.000Z"
  };

  it("PUTs a well-formed VCALENDAR with If-None-Match", async () => {
    const { impl, calls } = fetchSequence([response(201)]);
    const res = await createCaldavEvent(CREDS, CAL_URL, EVENT, { fetchImpl: impl });
    expect(res).toEqual({ eventUid: "newcoworker-abc-123" });
    expect(calls[0].url).toBe(`${CAL_URL}newcoworker-abc-123.ics`);
    expect(calls[0].init.method).toBe("PUT");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["If-None-Match"]).toBe("*");
    const body = calls[0].init.body as string;
    expect(body).toContain("UID:newcoworker-abc-123");
    expect(body).toContain("DTSTART:20260714T160000Z");
    expect(body).toContain("DTEND:20260714T163000Z");
    expect(body).toContain("SUMMARY:Consult\\; with Amy");
    expect(body).toContain("DESCRIPTION:Attendee: Amy\\nPhone: +16025550147");
  });

  it("rejects a path-unsafe UID before any request", async () => {
    const { impl } = fetchSequence([response(201)]);
    await expect(
      createCaldavEvent(CREDS, CAL_URL, { ...EVENT, uid: "../escape" }, { fetchImpl: impl })
    ).rejects.toMatchObject({ code: "request_failed" });
    expect(impl).not.toHaveBeenCalled();
  });

  it("throws when the server refuses the PUT", async () => {
    const { impl } = fetchSequence([response(409, "exists")]);
    await expect(
      createCaldavEvent(CREDS, CAL_URL, EVENT, { fetchImpl: impl })
    ).rejects.toMatchObject({ code: "request_failed", status: 409 });
  });
});

describe("updateCaldavEventTime", () => {
  const CAL_URL = "https://p42-caldav.icloud.com/123/calendars/home/";
  const UID = "newcoworker-abc-123";
  const NEW_START = "2026-07-15T20:00:00.000Z";
  const NEW_END = "2026-07-15T20:30:00.000Z";

  const STORED_ICAL =
    "BEGIN:VCALENDAR\r\n" +
    "VERSION:2.0\r\n" +
    "PRODID:-//NewCoworker//Calendar Integration//EN\r\n" +
    "BEGIN:VEVENT\r\n" +
    `UID:${UID}\r\n` +
    "DTSTAMP:20260713T000000Z\r\n" +
    "DTSTART:20260714T160000Z\r\n" +
    "DTEND:20260714T163000Z\r\n" +
    "SUMMARY:Consult with Amy\r\n" +
    "DESCRIPTION:Attendee: Amy\\nPhone: +16025550147\r\n" +
    "STATUS:CONFIRMED\r\n" +
    "END:VEVENT\r\n" +
    "END:VCALENDAR\r\n";

  it("GETs the resource, rewrites the times in place, and PUTs it back", async () => {
    const { impl, calls } = fetchSequence([response(200, STORED_ICAL), response(204)]);
    await updateCaldavEventTime(CREDS, CAL_URL, UID, NEW_START, NEW_END, { fetchImpl: impl });

    expect(calls[0].url).toBe(`${CAL_URL}${UID}.ics`);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[1].init.method).toBe("PUT");
    // No If-None-Match on the update PUT — it must overwrite the resource.
    expect((calls[1].init.headers as Record<string, string>)["If-None-Match"]).toBeUndefined();

    const body = calls[1].init.body as string;
    expect(body).toContain("DTSTART:20260715T200000Z");
    expect(body).toContain("DTEND:20260715T203000Z");
    // Everything else survives untouched; SEQUENCE:1 is introduced after UID
    // so clients treat this as an update to the SAME event.
    expect(body).toContain("SUMMARY:Consult with Amy");
    expect(body).toContain("DESCRIPTION:Attendee: Amy\\nPhone: +16025550147");
    expect(body).toMatch(new RegExp(`UID:${UID}\\r\\nSEQUENCE:1`));
    expect(body).not.toContain("DTSTAMP:20260713T000000Z");
  });

  it("increments an existing SEQUENCE and rewrites parameterized times", async () => {
    const withSeqAndTzid = STORED_ICAL
      .replace("DTSTART:20260714T160000Z", "DTSTART;TZID=America/Phoenix:20260714T090000")
      .replace("DTEND:20260714T163000Z", "DTEND;TZID=America/Phoenix:20260714T093000")
      .replace("STATUS:CONFIRMED\r\n", "STATUS:CONFIRMED\r\nSEQUENCE:2\r\n");
    const { impl, calls } = fetchSequence([response(200, withSeqAndTzid), response(200)]);
    await updateCaldavEventTime(CREDS, CAL_URL, UID, NEW_START, NEW_END, { fetchImpl: impl });
    const body = calls[1].init.body as string;
    // The TZID parameter is dropped in favor of a plain UTC instant.
    expect(body).toContain("DTSTART:20260715T200000Z");
    expect(body).toContain("DTEND:20260715T203000Z");
    expect(body).toContain("SEQUENCE:3");
    expect(body).not.toContain("SEQUENCE:1\r\n");
  });

  it("rewrites ONLY the VEVENT when a VTIMEZONE block precedes it", async () => {
    // Servers routinely prepend a VTIMEZONE whose STANDARD/DAYLIGHT
    // sub-components carry their own DTSTART lines — those must survive
    // untouched while the event's parameterized times are rewritten.
    const withTimezone =
      "BEGIN:VCALENDAR\r\n" +
      "VERSION:2.0\r\n" +
      "BEGIN:VTIMEZONE\r\n" +
      "TZID:America/Phoenix\r\n" +
      "BEGIN:STANDARD\r\n" +
      "DTSTART:19670430T020000\r\n" +
      "TZOFFSETFROM:-0700\r\n" +
      "TZOFFSETTO:-0700\r\n" +
      "END:STANDARD\r\n" +
      "END:VTIMEZONE\r\n" +
      "BEGIN:VEVENT\r\n" +
      `UID:${UID}\r\n` +
      "DTSTAMP:20260713T000000Z\r\n" +
      "DTSTART;TZID=America/Phoenix:20260714T090000\r\n" +
      "DTEND;TZID=America/Phoenix:20260714T093000\r\n" +
      "SUMMARY:Consult with $Amy\r\n" +
      "END:VEVENT\r\n" +
      "END:VCALENDAR\r\n";
    const { impl, calls } = fetchSequence([response(200, withTimezone), response(204)]);
    await updateCaldavEventTime(CREDS, CAL_URL, UID, NEW_START, NEW_END, { fetchImpl: impl });
    const body = calls[1].init.body as string;
    // The timezone definition's DTSTART is untouched.
    expect(body).toContain("DTSTART:19670430T020000");
    // The EVENT's times were rewritten.
    expect(body).toContain("DTSTART:20260715T200000Z");
    expect(body).toContain("DTEND:20260715T203000Z");
    // A literal `$` in event text never triggers replacement expansion.
    expect(body).toContain("SUMMARY:Consult with $Amy");
    expect(body).toMatch(new RegExp(`UID:${UID}\\r\\nSEQUENCE:1`));
  });

  it("refuses a body without a VEVENT component", async () => {
    const noEvent =
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:X\r\nEND:VTIMEZONE\r\nEND:VCALENDAR\r\n";
    const { impl, calls } = fetchSequence([response(200, noEvent)]);
    await expect(
      updateCaldavEventTime(CREDS, CAL_URL, UID, NEW_START, NEW_END, { fetchImpl: impl })
    ).rejects.toMatchObject({ code: "request_failed" });
    expect(calls).toHaveLength(1); // GET only — no PUT went out
  });

  it("rejects a path-unsafe UID before any request", async () => {
    const { impl } = fetchSequence([response(200)]);
    await expect(
      updateCaldavEventTime(CREDS, CAL_URL, "../escape", NEW_START, NEW_END, { fetchImpl: impl })
    ).rejects.toMatchObject({ code: "request_failed" });
    expect(impl).not.toHaveBeenCalled();
  });

  it("surfaces a missing resource with the 404 status", async () => {
    const { impl } = fetchSequence([response(404, "gone")]);
    await expect(
      updateCaldavEventTime(CREDS, CAL_URL, UID, NEW_START, NEW_END, { fetchImpl: impl })
    ).rejects.toMatchObject({ code: "request_failed", status: 404 });
  });

  it("refuses to blind-PUT a body without usable DTSTART/DTEND", async () => {
    const dateOnly = STORED_ICAL
      .replace("DTSTART:20260714T160000Z\r\n", "DTSTART;VALUE=DATE:20260714\r\n")
      .replace("DTEND:20260714T163000Z\r\n", "");
    // The DTSTART;VALUE=DATE line gets rewritten, but DTEND is absent — the
    // guard must refuse rather than PUT an event we cannot fully retime.
    const { impl, calls } = fetchSequence([response(200, dateOnly)]);
    await expect(
      updateCaldavEventTime(CREDS, CAL_URL, UID, NEW_START, NEW_END, { fetchImpl: impl })
    ).rejects.toMatchObject({ code: "request_failed" });
    expect(calls).toHaveLength(1); // GET only — no PUT went out
  });

  it("throws when the server refuses the PUT", async () => {
    const { impl } = fetchSequence([response(200, STORED_ICAL), response(412, "precondition")]);
    await expect(
      updateCaldavEventTime(CREDS, CAL_URL, UID, NEW_START, NEW_END, { fetchImpl: impl })
    ).rejects.toMatchObject({ code: "request_failed", status: 412 });
  });
});

describe("deleteCaldavEvent", () => {
  const CAL_URL = "https://p42-caldav.icloud.com/123/calendars/home/";

  it("DELETEs the event resource", async () => {
    const { impl, calls } = fetchSequence([response(204)]);
    await deleteCaldavEvent(CREDS, CAL_URL, "newcoworker-abc-123", { fetchImpl: impl });
    expect(calls[0].url).toBe(`${CAL_URL}newcoworker-abc-123.ics`);
    expect(calls[0].init.method).toBe("DELETE");
  });

  it("treats a 404 as success (idempotent cancel) but rejects other failures", async () => {
    const gone = fetchSequence([response(404)]);
    await expect(
      deleteCaldavEvent(CREDS, CAL_URL, "newcoworker-abc-123", { fetchImpl: gone.impl })
    ).resolves.toBeUndefined();

    const refused = fetchSequence([response(423, "locked")]);
    await expect(
      deleteCaldavEvent(CREDS, CAL_URL, "newcoworker-abc-123", { fetchImpl: refused.impl })
    ).rejects.toMatchObject({ code: "request_failed", status: 423 });
  });

  it("rejects a path-unsafe UID before any request", async () => {
    const { impl } = fetchSequence([response(204)]);
    await expect(
      deleteCaldavEvent(CREDS, CAL_URL, "../escape", { fetchImpl: impl })
    ).rejects.toMatchObject({ code: "request_failed" });
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("verifyCaldavConnection", () => {
  it("returns the discovered calendars on success", async () => {
    const { impl } = fetchSequence([
      response(207, PRINCIPAL_XML),
      response(207, HOME_XML),
      response(207, LIST_XML)
    ]);
    const res = await verifyCaldavConnection(CREDS, { fetchImpl: impl });
    expect(res).toEqual({
      ok: true,
      calendars: [{ url: "https://p42-caldav.icloud.com/123/calendars/home/", name: "Home" }]
    });
  });

  it("fails when no event calendars are found", async () => {
    const { impl } = fetchSequence([
      response(207, PRINCIPAL_XML),
      response(207, HOME_XML),
      response(207, "<multistatus/>")
    ]);
    expect(await verifyCaldavConnection(CREDS, { fetchImpl: impl })).toEqual({
      ok: false,
      reason: "request_failed"
    });
  });

  it("maps CaldavApiError codes through", async () => {
    const { impl } = fetchSequence([response(401)]);
    expect(await verifyCaldavConnection(CREDS, { fetchImpl: impl })).toEqual({
      ok: false,
      reason: "auth_failed"
    });
  });

  it("maps unexpected non-Error throws to request_failed", async () => {
    const impl = vi.fn(async () => ({
      status: 200,
      headers: { get: () => null },
      text: () => Promise.reject("kaboom")
    })) as unknown as typeof fetch;
    expect(await verifyCaldavConnection(CREDS, { fetchImpl: impl })).toEqual({
      ok: false,
      reason: "request_failed"
    });
  });
});
