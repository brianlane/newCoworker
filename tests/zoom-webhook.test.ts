/**
 * Tests for the Zoom Marketplace webhook core (src/lib/zoom/webhook.ts):
 * signature verification and timestamp freshness, the url_validation
 * challenge, payload parsing/extraction, the webhook transcript download,
 * and every dispatch outcome of processZoomWebhookEvent.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
// Every collaborator is injected; mock the modules so importing the core
// stays hermetic (no supabase module init at test load).
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/db/zoom-connections", () => ({
  getActiveZoomConnectionSummariesByZoomUserId: vi.fn(),
  getZoomConnectionBusinessIdsByZoomUserId: vi.fn(),
  markZoomConnectionDeauthorized: vi.fn()
}));
vi.mock("@/lib/db/zoom-transcript-imports", () => ({
  claimZoomTranscriptImport: vi.fn(),
  finalizeZoomTranscriptImport: vi.fn(),
  releaseZoomTranscriptImport: vi.fn()
}));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));
vi.mock("@/lib/zoom/import-core", () => ({ importZoomTranscriptDocument: vi.fn() }));
vi.mock("@/lib/zoom/transcript", () => ({ fetchZoomMeetingTranscript: vi.fn() }));

import {
  buildUrlValidationResponse,
  extractTranscriptCompleted,
  fetchWebhookTranscriptVtt,
  isTrustedZoomDownloadUrl,
  parseZoomWebhookBody,
  processZoomWebhookEvent,
  verifyZoomWebhookSignature,
  type ZoomWebhookDeps
} from "@/lib/zoom/webhook";

const SECRET = "zoom-secret-token";
const BIZ = "11111111-1111-4111-8111-111111111111";
const DOC_ID = "22222222-2222-4222-8222-222222222222";
const HOST = "zoom-user-1";
const UUID = "jhqVQlf1RyuEX/1TCRs+Jg==";
const VTT = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nBrian: Hello everyone\n";

function sign(body: string, tsSeconds: number): string {
  return `v0=${createHmac("sha256", SECRET).update(`v0:${tsSeconds}:${body}`).digest("hex")}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ZOOM_SECRET_TOKEN", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("verifyZoomWebhookSignature", () => {
  const body = '{"event":"x"}';
  const now = 1_800_000_000_000; // ms
  const ts = Math.floor(now / 1000);

  it("accepts a fresh, correctly signed delivery", () => {
    expect(verifyZoomWebhookSignature(body, String(ts), sign(body, ts), now)).toBe(true);
  });

  it("rejects when the secret is not configured", () => {
    vi.stubEnv("ZOOM_SECRET_TOKEN", "");
    expect(verifyZoomWebhookSignature(body, String(ts), sign(body, ts), now)).toBe(false);
  });

  it("rejects when the secret env var is absent entirely", () => {
    vi.unstubAllEnvs();
    const prev = process.env.ZOOM_SECRET_TOKEN;
    delete process.env.ZOOM_SECRET_TOKEN;
    try {
      expect(verifyZoomWebhookSignature(body, String(ts), sign(body, ts), now)).toBe(false);
    } finally {
      if (prev !== undefined) process.env.ZOOM_SECRET_TOKEN = prev;
    }
  });

  it("rejects missing headers", () => {
    expect(verifyZoomWebhookSignature(body, null, sign(body, ts), now)).toBe(false);
    expect(verifyZoomWebhookSignature(body, String(ts), null, now)).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(verifyZoomWebhookSignature(body, "not-a-ts", sign(body, ts), now)).toBe(false);
  });

  it("rejects a stale timestamp (replay window)", () => {
    const stale = ts - 6 * 60; // six minutes old
    expect(verifyZoomWebhookSignature(body, String(stale), sign(body, stale), now)).toBe(
      false
    );
  });

  it("rejects a tampered signature of the same length", () => {
    const good = sign(body, ts);
    const bad = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
    expect(verifyZoomWebhookSignature(body, String(ts), bad, now)).toBe(false);
  });

  it("rejects a signature of a different length", () => {
    expect(verifyZoomWebhookSignature(body, String(ts), "v0=short", now)).toBe(false);
  });
});

describe("buildUrlValidationResponse", () => {
  it("answers the challenge with the HMAC of the plainToken", () => {
    const res = buildUrlValidationResponse("abc123");
    expect(res).toEqual({
      plainToken: "abc123",
      encryptedToken: createHmac("sha256", SECRET).update("abc123").digest("hex")
    });
  });

  it("returns null when the secret is not configured", () => {
    vi.stubEnv("ZOOM_SECRET_TOKEN", "  ");
    expect(buildUrlValidationResponse("abc123")).toBeNull();
  });
});

describe("parseZoomWebhookBody", () => {
  it("parses event and payload", () => {
    expect(parseZoomWebhookBody({ event: "e", payload: { a: 1 } })).toEqual({
      event: "e",
      payload: { a: 1 }
    });
  });

  it("defaults a missing/non-object payload to an empty record", () => {
    expect(parseZoomWebhookBody({ event: "e" })).toEqual({ event: "e", payload: {} });
    expect(parseZoomWebhookBody({ event: "e", payload: [1] })).toEqual({
      event: "e",
      payload: {}
    });
  });

  it("returns null for non-objects and missing event names", () => {
    expect(parseZoomWebhookBody(null)).toBeNull();
    expect(parseZoomWebhookBody("x")).toBeNull();
    expect(parseZoomWebhookBody({ payload: {} })).toBeNull();
    expect(parseZoomWebhookBody({ event: "  " })).toBeNull();
  });
});

function transcriptBody(overrides: Record<string, unknown> = {}) {
  return {
    event: "recording.transcript_completed",
    download_token: "dl-token",
    payload: {
      object: {
        uuid: UUID,
        id: 1784344402882,
        host_id: HOST,
        topic: "Team sync",
        recording_files: [
          { file_type: "MP4", download_url: "https://zoom.us/rec/video" },
          {
            file_type: "TRANSCRIPT",
            file_extension: "VTT",
            download_url: "https://zoom.us/rec/transcript"
          }
        ],
        ...overrides
      }
    }
  };
}

describe("extractTranscriptCompleted", () => {
  function extract(body: ReturnType<typeof transcriptBody>) {
    const event = parseZoomWebhookBody(body);
    if (!event) throw new Error("unparseable test body");
    return extractTranscriptCompleted(event, body);
  }

  it("pulls host, uuid, topic, numeric id, transcript url, and token", () => {
    expect(extract(transcriptBody())).toEqual({
      hostId: HOST,
      meetingUuid: UUID,
      topic: "Team sync",
      meetingId: "1784344402882",
      downloadUrl: "https://zoom.us/rec/transcript",
      downloadToken: "dl-token"
    });
  });

  it("returns null when host or uuid is missing", () => {
    expect(extract(transcriptBody({ host_id: undefined }))).toBeNull();
    expect(extract(transcriptBody({ uuid: undefined }))).toBeNull();
  });

  it("matches transcript files by VTT extension and skips urlless entries", () => {
    const body = transcriptBody({
      recording_files: [
        { file_type: "TRANSCRIPT" },
        { file_extension: "vtt", download_url: "https://zoom.us/rec/vtt" }
      ]
    });
    expect(extract(body)?.downloadUrl).toBe("https://zoom.us/rec/vtt");
  });

  it("tolerates absent or non-array recording_files and non-record entries", () => {
    expect(extract(transcriptBody({ recording_files: undefined }))?.downloadUrl).toBeNull();
    expect(extract(transcriptBody({ recording_files: "x" }))?.downloadUrl).toBeNull();
    expect(extract(transcriptBody({ recording_files: [null, 3] }))?.downloadUrl).toBeNull();
  });

  it("accepts a string meeting id and drops non-numeric ids", () => {
    expect(extract(transcriptBody({ id: "876 3018 1550" }))?.meetingId).toBe("87630181550");
    expect(extract(transcriptBody({ id: "abc" }))?.meetingId).toBeNull();
    expect(extract(transcriptBody({ id: undefined }))?.meetingId).toBeNull();
  });

  it("returns a null token when the delivery carries none", () => {
    const body = transcriptBody();
    delete (body as Record<string, unknown>).download_token;
    expect(extract(body)?.downloadToken).toBeNull();
  });
});

describe("isTrustedZoomDownloadUrl", () => {
  it("accepts https URLs on Zoom-owned hosts only", () => {
    expect(isTrustedZoomDownloadUrl("https://zoom.us/rec/download/abc")).toBe(true);
    expect(isTrustedZoomDownloadUrl("https://us06web.zoom.us/rec/abc")).toBe(true);
    expect(isTrustedZoomDownloadUrl("https://cdn.zoom.com/rec/abc")).toBe(true);
  });

  it("rejects non-https, non-zoom hosts, lookalikes, and junk", () => {
    expect(isTrustedZoomDownloadUrl("http://zoom.us/rec/abc")).toBe(false);
    expect(isTrustedZoomDownloadUrl("https://evil.example.com/rec")).toBe(false);
    expect(isTrustedZoomDownloadUrl("https://notzoom.us.evil.com/rec")).toBe(false);
    expect(isTrustedZoomDownloadUrl("https://169.254.169.254/latest")).toBe(false);
    expect(isTrustedZoomDownloadUrl("not a url")).toBe(false);
  });
});

const ZOOM_DL = "https://zoom.us/rec/transcript";

describe("fetchWebhookTranscriptVtt", () => {
  it("downloads and returns a VTT body (BOM tolerated)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(`\uFEFF${VTT}`));
    expect(await fetchWebhookTranscriptVtt(ZOOM_DL, "t", fetchImpl as never)).toContain(
      "WEBVTT"
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      ZOOM_DL,
      expect.objectContaining({ headers: { Authorization: "Bearer t" } })
    );
  });

  it("refuses to fetch an untrusted URL at all (SSRF guard)", async () => {
    const fetchImpl = vi.fn();
    expect(
      await fetchWebhookTranscriptVtt("https://evil.example.com/x", "t", fetchImpl as never)
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    expect(await fetchWebhookTranscriptVtt(ZOOM_DL, "t", fetchImpl as never)).toBeNull();
  });

  it("returns null when the body is not a VTT transcript", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>login</html>"));
    expect(await fetchWebhookTranscriptVtt(ZOOM_DL, "t", fetchImpl as never)).toBeNull();
  });

  it("returns null when the download throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("net down"));
    expect(await fetchWebhookTranscriptVtt(ZOOM_DL, "t", fetchImpl as never)).toBeNull();
  });

  it("aborts a hung download at the timeout budget", async () => {
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
      const pending = fetchWebhookTranscriptVtt(ZOOM_DL, "t", fetchImpl);
      await vi.advanceTimersByTimeAsync(21_000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

function makeDeps(overrides: Partial<Record<keyof ZoomWebhookDeps, unknown>> = {}) {
  const deps = {
    connectionsByZoomUserId: vi
      .fn()
      .mockResolvedValue([{ business_id: BIZ, auto_import_transcripts: true }]),
    deauthBusinessIdsByZoomUserId: vi.fn().mockResolvedValue([BIZ]),
    getBusinessFn: vi.fn().mockResolvedValue({ name: "Acme Spa", tier: "standard" }),
    claimImport: vi.fn().mockResolvedValue(true),
    releaseImport: vi.fn().mockResolvedValue(undefined),
    finalizeImport: vi.fn().mockResolvedValue(true),
    fetchWebhookVtt: vi.fn().mockResolvedValue(VTT),
    fetchConnectionTranscript: vi.fn().mockResolvedValue({ ok: true, vtt: VTT }),
    importCore: vi.fn().mockResolvedValue({
      ok: true,
      document: { id: DOC_ID },
      status: "ready",
      errorDetail: null,
      summary: "Recap"
    }),
    deauthorize: vi.fn().mockResolvedValue(undefined),
    logSystem: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
  return deps as never as Required<ZoomWebhookDeps> & Record<string, ReturnType<typeof vi.fn>>;
}

describe("processZoomWebhookEvent", () => {
  it("ignores unparseable bodies and unknown events", async () => {
    const deps = makeDeps();
    expect(await processZoomWebhookEvent(null, deps)).toEqual({
      kind: "ignored",
      event: "unparseable"
    });
    expect(await processZoomWebhookEvent({ event: "meeting.started" }, deps)).toEqual({
      kind: "ignored",
      event: "meeting.started"
    });
  });

  it("answers the url_validation challenge (empty token tolerated)", async () => {
    const deps = makeDeps();
    const result = await processZoomWebhookEvent(
      { event: "endpoint.url_validation", payload: { plainToken: "abc" } },
      deps
    );
    expect(result.kind).toBe("url_validation");
    if (result.kind === "url_validation") {
      expect(result.response?.plainToken).toBe("abc");
    }

    const empty = await processZoomWebhookEvent(
      { event: "endpoint.url_validation", payload: {} },
      deps
    );
    if (empty.kind === "url_validation") {
      expect(empty.response?.plainToken).toBe("");
    }
  });

  it("deauthorizes every business behind the Zoom user, active or not", async () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    const deps = makeDeps({
      deauthBusinessIdsByZoomUserId: vi.fn().mockResolvedValue([BIZ, OTHER])
    });
    const result = await processZoomWebhookEvent(
      { event: "app_deauthorized", payload: { user_id: HOST } },
      deps
    );
    expect(result).toEqual({ kind: "deauthorized", businessIds: [BIZ, OTHER] });
    expect(deps.deauthorize).toHaveBeenCalledWith(BIZ);
    expect(deps.deauthorize).toHaveBeenCalledWith(OTHER);
    expect(deps.logSystem).toHaveBeenCalledWith(
      expect.objectContaining({ event: "zoom_deauthorized", businessId: BIZ })
    );
  });

  it("no-ops a deauthorization with no user id or no matching tenant", async () => {
    const deps = makeDeps();
    expect(
      await processZoomWebhookEvent({ event: "app_deauthorized", payload: {} }, deps)
    ).toEqual({ kind: "deauthorized", businessIds: [] });
    expect(deps.deauthBusinessIdsByZoomUserId).not.toHaveBeenCalled();

    const unknown = makeDeps({
      deauthBusinessIdsByZoomUserId: vi.fn().mockResolvedValue([])
    });
    expect(
      await processZoomWebhookEvent(
        { event: "app_deauthorized", payload: { user_id: "zu-x" } },
        unknown
      )
    ).toEqual({ kind: "deauthorized", businessIds: [] });
    expect(unknown.deauthorize).not.toHaveBeenCalled();
  });

  it("marks an unusable transcript payload without touching the ledger", async () => {
    const deps = makeDeps();
    const result = await processZoomWebhookEvent(
      { event: "recording.transcript_completed", payload: { object: {} } },
      deps
    );
    expect(result).toEqual({ kind: "transcript", outcome: "unusable", businessId: null });
    expect(deps.claimImport).not.toHaveBeenCalled();
  });

  it("skips hosts with no active connection", async () => {
    const deps = makeDeps({ connectionsByZoomUserId: vi.fn().mockResolvedValue([]) });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({
      kind: "transcript",
      outcome: "no_connection",
      businessId: null
    });
  });

  it("honors the tenant's auto-import switch", async () => {
    const deps = makeDeps({
      connectionsByZoomUserId: vi
        .fn()
        .mockResolvedValue([{ business_id: BIZ, auto_import_transcripts: false }])
    });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({ kind: "transcript", outcome: "disabled", businessId: BIZ });
    expect(deps.claimImport).not.toHaveBeenCalled();
  });

  it("imports for every business behind a shared Zoom account", async () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    const deps = makeDeps({
      connectionsByZoomUserId: vi.fn().mockResolvedValue([
        { business_id: BIZ, auto_import_transcripts: true },
        { business_id: OTHER, auto_import_transcripts: true }
      ])
    });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({ kind: "transcript", outcome: "imported", businessId: BIZ });
    expect(deps.claimImport).toHaveBeenCalledWith(BIZ, UUID);
    expect(deps.claimImport).toHaveBeenCalledWith(OTHER, UUID);
    expect(deps.importCore).toHaveBeenCalledTimes(2);
  });

  it("reports the loudest outcome across businesses (one failure wins)", async () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    const deps = makeDeps({
      connectionsByZoomUserId: vi.fn().mockResolvedValue([
        { business_id: BIZ, auto_import_transcripts: true },
        { business_id: OTHER, auto_import_transcripts: true }
      ]),
      importCore: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          document: { id: DOC_ID },
          status: "ready",
          errorDetail: null,
          summary: "Recap"
        })
        .mockRejectedValueOnce(new Error("second business boom"))
    });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({
      kind: "transcript",
      outcome: "import_failed",
      businessId: OTHER
    });
    // The succeeded business keeps its claim; only the failed one releases.
    expect(deps.releaseImport).toHaveBeenCalledTimes(1);
    expect(deps.releaseImport).toHaveBeenCalledWith(OTHER, UUID);
  });

  it("collapses redeliveries through the ledger claim", async () => {
    const deps = makeDeps({ claimImport: vi.fn().mockResolvedValue(false) });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({ kind: "transcript", outcome: "duplicate", businessId: BIZ });
    expect(deps.importCore).not.toHaveBeenCalled();
  });

  it("imports via the webhook download token and finalizes the claim", async () => {
    const deps = makeDeps();
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({ kind: "transcript", outcome: "imported", businessId: BIZ });
    expect(deps.fetchWebhookVtt).toHaveBeenCalledWith(
      "https://zoom.us/rec/transcript",
      "dl-token"
    );
    expect(deps.fetchConnectionTranscript).not.toHaveBeenCalled();
    expect(deps.importCore).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        title: "Team sync (transcript)",
        refLabel: "1784344402882"
      })
    );
    expect(deps.finalizeImport).toHaveBeenCalledWith(BIZ, UUID, DOC_ID);
  });

  it("falls back to the connection token when the webhook download fails", async () => {
    const deps = makeDeps({ fetchWebhookVtt: vi.fn().mockResolvedValue(null) });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({ kind: "transcript", outcome: "imported", businessId: BIZ });
    expect(deps.fetchConnectionTranscript).toHaveBeenCalledWith(BIZ, UUID);
  });

  it("skips the webhook download when the delivery carries no token", async () => {
    const body = transcriptBody();
    delete (body as Record<string, unknown>).download_token;
    const deps = makeDeps();
    await processZoomWebhookEvent(body, deps);
    expect(deps.fetchWebhookVtt).not.toHaveBeenCalled();
    expect(deps.fetchConnectionTranscript).toHaveBeenCalledWith(BIZ, UUID);
  });

  it("titles untitled meetings from the meeting id, else a generic label", async () => {
    const deps = makeDeps();
    await processZoomWebhookEvent(transcriptBody({ topic: undefined }), deps);
    expect(deps.importCore).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Zoom meeting 1784344402882 (transcript)" })
    );

    const deps2 = makeDeps();
    await processZoomWebhookEvent(transcriptBody({ topic: undefined, id: undefined }), deps2);
    expect(deps2.importCore).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Zoom meeting recording (transcript)", refLabel: "recording" })
    );
  });

  it("releases the claim and fails when no transcript can be fetched", async () => {
    const deps = makeDeps({
      fetchWebhookVtt: vi.fn().mockResolvedValue(null),
      fetchConnectionTranscript: vi
        .fn()
        .mockResolvedValue({ ok: false, error: "not_found", detail: "gone" })
    });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({
      kind: "transcript",
      outcome: "import_failed",
      businessId: BIZ
    });
    expect(deps.releaseImport).toHaveBeenCalledWith(BIZ, UUID);
  });

  it("releases the claim when the business row is missing", async () => {
    const deps = makeDeps({ getBusinessFn: vi.fn().mockResolvedValue(null) });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({
      kind: "transcript",
      outcome: "import_failed",
      businessId: BIZ
    });
    expect(deps.releaseImport).toHaveBeenCalledWith(BIZ, UUID);
  });

  it("skips quietly at the document cap (claim released, activity logged)", async () => {
    const deps = makeDeps({
      importCore: vi
        .fn()
        .mockResolvedValue({ ok: false, error: "limit_reached", detail: "cap" })
    });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({
      kind: "transcript",
      outcome: "skipped_permanent",
      businessId: BIZ
    });
    expect(deps.releaseImport).toHaveBeenCalledWith(BIZ, UUID);
    expect(deps.logSystem).toHaveBeenCalledWith(
      expect.objectContaining({ event: "zoom_auto_import_skipped_cap" })
    );
  });

  it("skips quietly on an oversized transcript (permanent, no retry storm)", async () => {
    const deps = makeDeps({
      importCore: vi
        .fn()
        .mockResolvedValue({ ok: false, error: "too_large", detail: "10 MB" })
    });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({
      kind: "transcript",
      outcome: "skipped_permanent",
      businessId: BIZ
    });
    expect(deps.logSystem).toHaveBeenCalledWith(
      expect.objectContaining({ event: "zoom_auto_import_skipped_too_large" })
    );
  });

  it("fails (for redelivery) on transient import refusals", async () => {
    const deps = makeDeps({
      importCore: vi
        .fn()
        .mockResolvedValue({ ok: false, error: "storage_failed", detail: "bucket" })
    });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({
      kind: "transcript",
      outcome: "import_failed",
      businessId: BIZ
    });
    expect(deps.releaseImport).toHaveBeenCalledWith(BIZ, UUID);
  });

  it("releases the claim when the import throws unexpectedly", async () => {
    const deps = makeDeps({
      importCore: vi.fn().mockRejectedValue(new Error("boom"))
    });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({
      kind: "transcript",
      outcome: "import_failed",
      businessId: BIZ
    });
    expect(deps.releaseImport).toHaveBeenCalledWith(BIZ, UUID);
  });

  it("escalates loudly when the ledger stamp fails twice (claim kept)", async () => {
    const deps = makeDeps({ finalizeImport: vi.fn().mockResolvedValue(false) });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({ kind: "transcript", outcome: "imported", businessId: BIZ });
    expect(deps.finalizeImport).toHaveBeenCalledTimes(2);
    expect(deps.releaseImport).not.toHaveBeenCalled();
    expect(deps.logSystem).toHaveBeenCalledWith(
      expect.objectContaining({ event: "zoom_ledger_finalize_failed", level: "error" })
    );
  });

  it("retries the ledger stamp once and succeeds silently", async () => {
    const deps = makeDeps({
      finalizeImport: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({ kind: "transcript", outcome: "imported", businessId: BIZ });
    expect(deps.finalizeImport).toHaveBeenCalledTimes(2);
    expect(deps.logSystem).not.toHaveBeenCalled();
  });

  it("handles non-Error throws from the import path", async () => {
    const deps = makeDeps({
      importCore: vi.fn().mockRejectedValue("string boom")
    });
    const result = await processZoomWebhookEvent(transcriptBody(), deps);
    expect(result).toEqual({
      kind: "transcript",
      outcome: "import_failed",
      businessId: BIZ
    });
  });
});
