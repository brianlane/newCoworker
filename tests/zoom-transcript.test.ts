/**
 * Tests for the Zoom meeting-transcript fetch (src/lib/zoom/transcript.ts):
 * token resolution, every HTTP failure class of the transcript lookup,
 * download restrictions, and the WEBVTT sanity check on the downloaded body.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const getZoomAccessToken = vi.fn();
vi.mock("@/lib/zoom/client", () => ({
  getZoomAccessToken: (...args: unknown[]) => getZoomAccessToken(...args)
}));

import {
  buildZoomTranscriptRefLabel,
  buildZoomTranscriptTitle,
  fetchPastMeetingMeta,
  fetchZoomMeetingTranscript,
  formatZoomMeetingDate,
  normalizeZoomMeetingRef,
  rawZoomMeetingUuid,
  resolvePastMeetingUuid
} from "@/lib/zoom/transcript";

const BIZ = "11111111-1111-4111-8111-111111111111";
const MEETING = "1784344402882";
const VTT = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nBrian: Hello everyone\n";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getZoomAccessToken.mockResolvedValue("tok-1");
});

describe("normalizeZoomMeetingRef", () => {
  it("keeps numeric ids, stripping display spacing", () => {
    expect(normalizeZoomMeetingRef("876 3018 1550")).toBe("87630181550");
    expect(normalizeZoomMeetingRef("1784344402882")).toBe("1784344402882");
  });

  it("URL-encodes a bare meeting UUID once", () => {
    expect(normalizeZoomMeetingRef("jhqVQlf1RyuEX/1TCRs+Jg==")).toBe(
      encodeURIComponent("jhqVQlf1RyuEX/1TCRs+Jg==")
    );
  });

  it("double-encodes UUIDs starting with / or containing //", () => {
    const leading = "/ajXp112QmuoKj4854875==";
    expect(normalizeZoomMeetingRef(leading)).toBe(
      encodeURIComponent(encodeURIComponent(leading))
    );
    const doubled = "abcdefghij//klmnopq==";
    expect(normalizeZoomMeetingRef(doubled)).toBe(
      encodeURIComponent(encodeURIComponent(doubled))
    );
  });

  it("extracts the UUID from a recording page link", () => {
    const link =
      "https://us06web.zoom.us/recording/detail?meeting_id=jhqVQlf1RyuEX%2F1TCRs%2BJg%3D%3D";
    expect(normalizeZoomMeetingRef(link)).toBe(
      encodeURIComponent("jhqVQlf1RyuEX/1TCRs+Jg==")
    );
  });

  it("rejects non-zoom links, zoom links without meeting_id, and junk", () => {
    expect(
      normalizeZoomMeetingRef("https://evil.example.com/?meeting_id=abc==")
    ).toBeNull();
    expect(normalizeZoomMeetingRef("https://zoom.us/recording/detail")).toBeNull();
    expect(normalizeZoomMeetingRef("https://[bad")).toBeNull();
    expect(normalizeZoomMeetingRef("not a meeting")).toBeNull();
    expect(normalizeZoomMeetingRef("  ")).toBeNull();
    expect(normalizeZoomMeetingRef("12345")).toBeNull();
  });
});

describe("rawZoomMeetingUuid", () => {
  it("returns the raw UUID from a recording page link", () => {
    const link =
      "https://us06web.zoom.us/recording/detail?meeting_id=jhqVQlf1RyuEX%2F1TCRs%2BJg%3D%3D";
    expect(rawZoomMeetingUuid(link)).toBe("jhqVQlf1RyuEX/1TCRs+Jg==");
  });

  it("returns a bare UUID unchanged", () => {
    expect(rawZoomMeetingUuid("jhqVQlf1RyuEX/1TCRs+Jg==")).toBe("jhqVQlf1RyuEX/1TCRs+Jg==");
  });

  it("returns null for numeric ids (no UUID to dedupe on)", () => {
    expect(rawZoomMeetingUuid("1784344402882")).toBeNull();
  });

  it("rejects non-zoom links, linkless params, bad URLs, and junk", () => {
    expect(rawZoomMeetingUuid("https://evil.example.com/?meeting_id=abc==")).toBeNull();
    expect(rawZoomMeetingUuid("https://zoom.us/recording/detail")).toBeNull();
    expect(rawZoomMeetingUuid("https://zoom.us/recording/detail?meeting_id=")).toBeNull();
    expect(rawZoomMeetingUuid("https://[bad")).toBeNull();
    expect(rawZoomMeetingUuid("not a meeting")).toBeNull();
    expect(rawZoomMeetingUuid("   ")).toBeNull();
  });
});

describe("buildZoomTranscriptTitle / refLabel", () => {
  it("prefers topic plus date, then falls back through id and dated generic", () => {
    expect(
      buildZoomTranscriptTitle({
        topic: "New Coworker's Zoom Meeting",
        startTime: "2026-07-29T16:03:00Z",
        meetingId: "84948156425"
      })
    ).toBe("New Coworker's Zoom Meeting · Jul 29, 2026 (transcript)");

    expect(buildZoomTranscriptTitle({ topic: "Team sync" })).toBe("Team sync (transcript)");
    expect(
      buildZoomTranscriptTitle({ meetingId: "1784344402882", startTime: "2026-07-19T12:00:00Z" })
    ).toBe("Zoom meeting 1784344402882 · Jul 19, 2026 (transcript)");
    expect(buildZoomTranscriptTitle({ meetingId: "1784344402882" })).toBe(
      "Zoom meeting 1784344402882 (transcript)"
    );
    expect(buildZoomTranscriptTitle({ startTime: "2026-07-29T16:03:00Z" })).toBe(
      "Zoom meeting · Jul 29, 2026 (transcript)"
    );
    expect(buildZoomTranscriptTitle({})).toBe("Zoom meeting recording (transcript)");
  });

  it("labels storage with the meeting id, else a date stamp, else recording", () => {
    expect(
      buildZoomTranscriptRefLabel({ meetingId: "84948156425", startTime: "2026-07-29T16:03:00Z" })
    ).toBe("84948156425");
    expect(buildZoomTranscriptRefLabel({ startTime: "2026-07-29T16:03:00Z" })).toBe("2026-07-29");
    expect(buildZoomTranscriptRefLabel({ startTime: "not-a-date" })).toBe("recording");
    expect(buildZoomTranscriptRefLabel({})).toBe("recording");
  });

  it("formats Zoom start times as a short UTC calendar date", () => {
    expect(formatZoomMeetingDate("2026-07-29T16:03:00Z")).toBe("Jul 29, 2026");
    expect(formatZoomMeetingDate("not-a-date")).toBeNull();
    expect(formatZoomMeetingDate(null)).toBeNull();
  });
});

describe("fetchPastMeetingMeta", () => {
  it("returns topic, start time, uuid, and numeric id from past_meetings", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        uuid: "jhqVQlf1RyuEX/1TCRs+Jg==",
        topic: " New Coworker's Zoom Meeting ",
        start_time: "2026-07-29T16:03:00Z",
        id: 84948156425
      })
    );
    expect(await fetchPastMeetingMeta(BIZ, MEETING, { fetchImpl })).toEqual({
      uuid: "jhqVQlf1RyuEX/1TCRs+Jg==",
      topic: "New Coworker's Zoom Meeting",
      startTime: "2026-07-29T16:03:00Z",
      meetingId: "84948156425"
    });
  });

  it("accepts a string meeting id and returns null for an empty body", async () => {
    const withStringId = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        uuid: "jhqVQlf1RyuEX/1TCRs+Jg==",
        topic: "Sync",
        start_time: "2026-07-29T16:03:00Z",
        id: "849 4815 6425"
      })
    );
    expect(await fetchPastMeetingMeta(BIZ, MEETING, { fetchImpl: withStringId })).toEqual({
      uuid: "jhqVQlf1RyuEX/1TCRs+Jg==",
      topic: "Sync",
      startTime: "2026-07-29T16:03:00Z",
      meetingId: "84948156425"
    });

    const empty = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    expect(await fetchPastMeetingMeta(BIZ, MEETING, { fetchImpl: empty })).toBeNull();

    const blankStringId = vi.fn().mockResolvedValue(
      jsonResponse(200, { uuid: "abc==", id: "not-numeric" })
    );
    expect(await fetchPastMeetingMeta(BIZ, MEETING, { fetchImpl: blankStringId })).toEqual({
      uuid: "abc==",
      topic: null,
      startTime: null,
      meetingId: null
    });
  });

  it("resolves a UUID or recording-link reference", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        uuid: "jhqVQlf1RyuEX/1TCRs+Jg==",
        topic: "From link",
        start_time: "2026-07-29T16:03:00Z",
        id: 84948156425
      })
    );
    const link =
      "https://us06web.zoom.us/recording/detail?meeting_id=jhqVQlf1RyuEX%2F1TCRs%2BJg%3D%3D";
    expect(await fetchPastMeetingMeta(BIZ, link, { fetchImpl })).toMatchObject({
      topic: "From link",
      meetingId: "84948156425"
    });
    expect(fetchImpl.mock.calls[0][0]).toContain(
      encodeURIComponent("jhqVQlf1RyuEX/1TCRs+Jg==")
    );
  });

  it("uses the production token and fetch defaults when deps are omitted", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        uuid: "jhqVQlf1RyuEX/1TCRs+Jg==",
        topic: "Default deps",
        start_time: "2026-07-29T16:03:00Z",
        id: 84948156425
      })
    ) as typeof fetch;
    try {
      expect(await fetchPastMeetingMeta(BIZ, MEETING)).toMatchObject({
        topic: "Default deps",
        meetingId: "84948156425"
      });
      expect(globalThis.fetch).toHaveBeenCalled();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("fails open on junk refs and non-2xx", async () => {
    expect(await fetchPastMeetingMeta(BIZ, "not-a-ref", { fetchImpl: vi.fn() })).toBeNull();
    const denied = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    expect(await fetchPastMeetingMeta(BIZ, MEETING, { fetchImpl: denied })).toBeNull();

    getZoomAccessToken.mockResolvedValueOnce(null);
    expect(await fetchPastMeetingMeta(BIZ, MEETING, { fetchImpl: vi.fn() })).toBeNull();
    getZoomAccessToken.mockRejectedValueOnce(new Error("refresh down"));
    expect(await fetchPastMeetingMeta(BIZ, MEETING, { fetchImpl: vi.fn() })).toBeNull();

    const down = vi.fn().mockRejectedValue(new Error("net down"));
    expect(await fetchPastMeetingMeta(BIZ, MEETING, { fetchImpl: down })).toBeNull();
  });
});

describe("resolvePastMeetingUuid", () => {
  const UUID_RAW = "jhqVQlf1RyuEX/1TCRs+Jg==";

  it("resolves a numeric id to the latest past-meeting instance UUID", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { uuid: ` ${UUID_RAW} ` }));
    expect(await resolvePastMeetingUuid(BIZ, MEETING, { fetchImpl })).toBe(UUID_RAW);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.zoom.us/v2/past_meetings/${MEETING}`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok-1" })
      })
    );
  });

  it("refuses non-numeric references without calling Zoom", async () => {
    const fetchImpl = vi.fn();
    expect(await resolvePastMeetingUuid(BIZ, UUID_RAW, { fetchImpl })).toBeNull();
    expect(await resolvePastMeetingUuid(BIZ, "12345", { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    // Default-deps entry (global fetch binding) with the same early return.
    expect(await resolvePastMeetingUuid(BIZ, "12345")).toBeNull();
  });

  it("fails open when the token is missing or resolution throws", async () => {
    const fetchImpl = vi.fn();
    getZoomAccessToken.mockResolvedValueOnce(null);
    expect(await resolvePastMeetingUuid(BIZ, MEETING, { fetchImpl })).toBeNull();

    getZoomAccessToken.mockRejectedValueOnce(new Error("refresh down"));
    expect(await resolvePastMeetingUuid(BIZ, MEETING, { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails open on non-2xx (pre-scope tokens 401 here) and on transport errors", async () => {
    const denied = vi.fn().mockResolvedValue(jsonResponse(401, { code: 124 }));
    expect(await resolvePastMeetingUuid(BIZ, MEETING, { fetchImpl: denied })).toBeNull();

    const down = vi.fn().mockRejectedValue(new Error("net down"));
    expect(await resolvePastMeetingUuid(BIZ, MEETING, { fetchImpl: down })).toBeNull();
  });

  it("returns null when the response carries no usable uuid", async () => {
    const noUuid = vi.fn().mockResolvedValue(jsonResponse(200, { id: 123 }));
    expect(await resolvePastMeetingUuid(BIZ, MEETING, { fetchImpl: noUuid })).toBeNull();

    const blank = vi.fn().mockResolvedValue(jsonResponse(200, { uuid: "  " }));
    expect(await resolvePastMeetingUuid(BIZ, MEETING, { fetchImpl: blank })).toBeNull();

    const badJson = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    expect(await resolvePastMeetingUuid(BIZ, MEETING, { fetchImpl: badJson })).toBeNull();
  });
});

describe("fetchZoomMeetingTranscript numeric-404 UUID retry", () => {
  const UUID_RAW = "jhqVQlf1RyuEX/1TCRs+Jg==";

  it("resolves the instance UUID and retries once on a numeric 404", async () => {
    const fetchImpl = vi
      .fn()
      // 1: numeric transcript lookup 404s (the instant-meeting quirk)
      .mockResolvedValueOnce(jsonResponse(404, { code: 3322 }))
      // 2: past_meetings resolves the instance UUID
      .mockResolvedValueOnce(jsonResponse(200, { uuid: UUID_RAW }))
      // 3: UUID transcript lookup succeeds
      .mockResolvedValueOnce(
        jsonResponse(200, { can_download: true, download_url: "https://zoom.us/dl/vtt" })
      )
      // 4: the VTT download
      .mockResolvedValueOnce(new Response(VTT));
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
    expect(res).toMatchObject({ ok: true });
    expect(fetchImpl.mock.calls[1][0]).toBe(
      `https://api.zoom.us/v2/past_meetings/${MEETING}`
    );
    expect(fetchImpl.mock.calls[2][0]).toBe(
      `https://api.zoom.us/v2/meetings/${encodeURIComponent(UUID_RAW)}/transcript`
    );
  });

  it("keeps the steer-to-link copy when the UUID cannot be resolved (pre-scope)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { code: 3322 }))
      .mockResolvedValueOnce(jsonResponse(401, { code: 124 }));
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
    expect(res).toMatchObject({ ok: false, error: "not_found" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not attempt resolution for a non-numeric 404", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(404, { code: 3301 }));
    const res = await fetchZoomMeetingTranscript(BIZ, UUID_RAW, { fetchImpl });
    expect(res).toMatchObject({ ok: false, error: "not_found" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("fetchZoomMeetingTranscript", () => {
  it("returns not_found for an unreadable meeting reference without calling Zoom", async () => {
    const fetchImpl = vi.fn();
    const res = await fetchZoomMeetingTranscript(BIZ, "definitely not a ref!", { fetchImpl });
    expect(res).toMatchObject({ ok: false, error: "not_found" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getZoomAccessToken).not.toHaveBeenCalled();
  });

  it("requests the transcript by encoded UUID when a recording link is pasted", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { can_download: true, download_url: "https://dl.zoom.us/t/1" })
      )
      .mockResolvedValueOnce(new Response(VTT, { status: 200 }));
    const link =
      "https://us06web.zoom.us/recording/detail?meeting_id=jhqVQlf1RyuEX%2F1TCRs%2BJg%3D%3D";
    const res = await fetchZoomMeetingTranscript(BIZ, link, { fetchImpl });
    expect(res.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `https://api.zoom.us/v2/meetings/${encodeURIComponent("jhqVQlf1RyuEX/1TCRs+Jg==")}/transcript`
    );
  });

  it("returns the VTT when the transcript is downloadable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { can_download: true, download_url: "https://dl.zoom.us/t/1" })
      )
      .mockResolvedValueOnce(new Response(VTT, { status: 200 }));

    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
    expect(res).toEqual({ ok: true, vtt: VTT.trim() });

    // Lookup goes to the meetings transcript endpoint with the bearer token.
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `https://api.zoom.us/v2/meetings/${MEETING}/transcript`
    );
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer tok-1");
    // Download hits the returned URL with the same token.
    expect(fetchImpl.mock.calls[1][0]).toBe("https://dl.zoom.us/t/1");
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe("Bearer tok-1");
  });

  it("accepts a BOM-prefixed WEBVTT body", async () => {
    const bom = `\uFEFF${VTT}`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { can_download: true, download_url: "https://dl.zoom.us/t/1" })
      )
      .mockResolvedValueOnce(new Response(bom, { status: 200 }));
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
    expect(res.ok).toBe(true);
  });

  it("uses the default token resolver and fetch when no deps are injected", async () => {
    // Token resolves to null, so the default global fetch is never reached,
    // this exercises the no-deps call path end to end.
    getZoomAccessToken.mockResolvedValue(null);
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING);
    expect(res).toMatchObject({ ok: false, error: "not_connected" });
    expect(getZoomAccessToken).toHaveBeenCalledWith(BIZ);
  });

  it("aborts a hung lookup at the timeout budget", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
          })
      ) as unknown as typeof fetch;
      const pending = fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
      await vi.advanceTimersByTimeAsync(21_000);
      const res = await pending;
      expect(res).toMatchObject({ ok: false, error: "request_failed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps a token-resolution throw to request_failed", async () => {
    const getToken = vi.fn().mockRejectedValue(new Error("upstream down"));
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, {
      getToken,
      fetchImpl: vi.fn()
    });
    expect(res).toMatchObject({ ok: false, error: "request_failed" });
  });

  it("maps a non-Error token-resolution throw to request_failed", async () => {
    const getToken = vi.fn().mockRejectedValue("boom");
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, {
      getToken,
      fetchImpl: vi.fn()
    });
    expect(res).toMatchObject({ ok: false, error: "request_failed" });
  });

  it("maps 401/403 on the lookup to not_connected (scope missing)", async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(status, {}));
      const res = await fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
      expect(res).toMatchObject({ ok: false, error: "not_connected" });
      if (!res.ok) expect(res.detail).toContain("Reconnect");
    }
  });

  it("maps 404 on the lookup to not_found", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
    expect(res).toMatchObject({ ok: false, error: "not_found" });
  });

  it("maps other lookup failures to request_failed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
    expect(res).toMatchObject({ ok: false, error: "request_failed" });
    if (!res.ok) expect(res.detail).toContain("500");
  });

  it("maps a lookup network failure to request_failed", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
    expect(res).toMatchObject({ ok: false, error: "request_failed" });
  });

  it("returns restricted with Zoom's reason when can_download is false", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        can_download: false,
        download_restriction_reason: "IP restriction"
      })
    );
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
    expect(res).toMatchObject({ ok: false, error: "restricted" });
    if (!res.ok) expect(res.detail).toContain("IP restriction");
  });

  it("returns restricted without a reason when Zoom gives none", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { can_download: true }));
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
    expect(res).toMatchObject({ ok: false, error: "restricted" });
  });

  it("returns restricted on an unparseable lookup body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
    expect(res).toMatchObject({ ok: false, error: "restricted" });
  });

  it("maps a download network failure to request_failed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { can_download: true, download_url: "https://dl.zoom.us/t/1" })
      )
      .mockRejectedValueOnce(new Error("timeout"));
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
    expect(res).toMatchObject({ ok: false, error: "request_failed" });
  });

  it("maps a non-2xx download to request_failed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { can_download: true, download_url: "https://dl.zoom.us/t/1" })
      )
      .mockResolvedValueOnce(new Response("nope", { status: 410 }));
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
    expect(res).toMatchObject({ ok: false, error: "request_failed" });
    if (!res.ok) expect(res.detail).toContain("410");
  });

  it("refuses a download body that isn't WebVTT", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { can_download: true, download_url: "https://dl.zoom.us/t/1" })
      )
      .mockResolvedValueOnce(new Response("<html>sign in</html>", { status: 200 }));
    const res = await fetchZoomMeetingTranscript(BIZ, MEETING, { fetchImpl });
    expect(res).toMatchObject({ ok: false, error: "request_failed" });
    if (!res.ok) expect(res.detail).toContain("VTT");
  });
});
