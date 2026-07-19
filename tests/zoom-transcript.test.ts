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

import { fetchZoomMeetingTranscript, normalizeZoomMeetingRef } from "@/lib/zoom/transcript";

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
    // Token resolves to null, so the default global fetch is never reached —
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
