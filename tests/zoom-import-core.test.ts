/**
 * Tests for the shared Zoom transcript-import pipeline
 * (src/lib/zoom/import-core.ts): tier cap (pre-insert and the serial
 * re-check), the 10 MB ceiling, storage failure/cleanup, and both
 * ingestion outcomes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
// Production collaborators are injected in every test; mock the modules so
// importing the core stays hermetic (no supabase/gemini/vps module init).
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/documents/db", () => ({
  countBusinessDocuments: vi.fn(),
  deleteBusinessDocument: vi.fn(),
  insertBusinessDocument: vi.fn(),
  patchBusinessDocument: vi.fn()
}));
vi.mock("@/lib/documents/ingest", () => ({
  ingestDocument: vi.fn()
}));
vi.mock("@/lib/vps/sync-vault", () => ({
  syncVaultToVpsAndLog: vi.fn()
}));

import {
  importZoomTranscriptDocument,
  MAX_ZOOM_TRANSCRIPT_BYTES,
  resolveHostNames
} from "@/lib/zoom/import-core";

const BIZ = "11111111-1111-4111-8111-111111111111";
const DOC_ID = "22222222-2222-4222-8222-222222222222";
const VTT = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nBrian: Hello everyone\n";

const DOC_ROW = { id: DOC_ID, business_id: BIZ, title: "T" };
const MEETING_UUID = "WRkTlvIESr+N4HTcIESuww==";

function makeStorage(uploadError: unknown = null, removeError: unknown = null) {
  const upload = vi.fn().mockResolvedValue({ error: uploadError });
  const remove = vi.fn().mockResolvedValue({ error: removeError });
  const client = { storage: { from: vi.fn(() => ({ upload, remove })) } };
  return { client: client as never, upload, remove };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const storage = makeStorage();
  return {
    storage,
    deps: {
      client: storage.client,
      countDocuments: vi.fn().mockResolvedValue(0),
      insertDocument: vi.fn().mockResolvedValue(DOC_ROW),
      patchDocument: vi.fn().mockResolvedValue(undefined),
      deleteDocument: vi.fn().mockResolvedValue(undefined),
      ingest: vi
        .fn()
        .mockResolvedValue({ ok: true, contentMd: "## Minutes", summary: "Short recap" }),
      syncVault: vi.fn().mockResolvedValue(undefined),
      scheduleClassification: vi.fn(),
      uuid: vi.fn(() => DOC_ID),
      ...overrides
    } as never
  };
}

const PARAMS = {
  businessId: BIZ,
  business: { name: "Acme Spa", tier: "standard" as never },
  vtt: VTT,
  title: "Team sync (transcript)",
  refLabel: "1784344402882"
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("importZoomTranscriptDocument", () => {
  it("refuses when the document cap is already reached", async () => {
    const { deps } = makeDeps({ countDocuments: vi.fn().mockResolvedValue(10_000) });
    const result = await importZoomTranscriptDocument(PARAMS, deps);
    expect(result).toMatchObject({ ok: false, error: "limit_reached" });
  });

  it("refuses a transcript over the 10 MB ceiling", async () => {
    const { deps } = makeDeps();
    const huge = "WEBVTT\n" + "x".repeat(MAX_ZOOM_TRANSCRIPT_BYTES);
    const result = await importZoomTranscriptDocument({ ...PARAMS, vtt: huge }, deps);
    expect(result).toMatchObject({ ok: false, error: "too_large" });
  });

  it("reports a storage failure without inserting a row", async () => {
    const storage = makeStorage({ message: "bucket down" });
    const { deps } = makeDeps({ client: storage.client });
    const result = await importZoomTranscriptDocument(PARAMS, deps);
    expect(result).toMatchObject({ ok: false, error: "storage_failed" });
  });

  it("cleans up the uploaded object when the row insert throws", async () => {
    const storage = makeStorage();
    const { deps } = makeDeps({
      client: storage.client,
      insertDocument: vi.fn().mockRejectedValue(new Error("insert boom"))
    });
    await expect(importZoomTranscriptDocument(PARAMS, deps)).rejects.toThrow(/insert boom/);
    expect(storage.remove).toHaveBeenCalledWith([
      `${BIZ}/${DOC_ID}/zoom-meeting-1784344402882.vtt`
    ]);
  });

  it("logs (but does not mask) an orphan-cleanup failure", async () => {
    const storage = makeStorage(null, { message: "remove failed" });
    const { deps } = makeDeps({
      client: storage.client,
      insertDocument: vi.fn().mockRejectedValue(new Error("insert boom"))
    });
    await expect(importZoomTranscriptDocument(PARAMS, deps)).rejects.toThrow(/insert boom/);
  });

  it("rolls back when the serial re-check finds the cap exceeded", async () => {
    const countDocuments = vi
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(10_000);
    const storage = makeStorage();
    const deleteDocument = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps({ client: storage.client, countDocuments, deleteDocument });
    const result = await importZoomTranscriptDocument(PARAMS, deps);
    expect(result).toMatchObject({ ok: false, error: "limit_reached" });
    expect(deleteDocument).toHaveBeenCalledWith(BIZ, DOC_ID);
    expect(storage.remove).toHaveBeenCalled();
  });

  it("stores, condenses, patches ready, and fires the vault sync on success", async () => {
    const { deps, storage } = makeDeps();
    const result = await importZoomTranscriptDocument(PARAMS, deps);
    expect(result).toMatchObject({
      ok: true,
      status: "ready",
      errorDetail: null,
      summary: "Short recap"
    });
    expect(storage.upload).toHaveBeenCalled();
    expect(storage.upload.mock.calls[0][2]).toEqual({
      contentType: "text/vtt"
    });
    const d = deps as { patchDocument: ReturnType<typeof vi.fn>; syncVault: ReturnType<typeof vi.fn> };
    expect(d.patchDocument).toHaveBeenCalledWith(BIZ, DOC_ID, {
      content_md: "## Minutes",
      summary: "Short recap",
      status: "ready",
      error_detail: null
    });
    expect(d.syncVault).toHaveBeenCalledWith(BIZ);
  });

  it("rolls back the document when a post-insert step throws (no retry duplicates)", async () => {
    const storage = makeStorage();
    const deleteDocument = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps({
      client: storage.client,
      deleteDocument,
      patchDocument: vi.fn().mockRejectedValue(new Error("patch boom"))
    });
    await expect(importZoomTranscriptDocument(PARAMS, deps)).rejects.toThrow(/patch boom/);
    expect(deleteDocument).toHaveBeenCalledWith(BIZ, DOC_ID);
    expect(storage.remove).toHaveBeenCalledWith([
      `${BIZ}/${DOC_ID}/zoom-meeting-1784344402882.vtt`
    ]);
  });

  it("marks the document failed when condensation fails (detail preferred)", async () => {
    const { deps } = makeDeps({
      ingest: vi.fn().mockResolvedValue({ ok: false, error: "model_error", detail: "quota" })
    });
    const result = await importZoomTranscriptDocument(PARAMS, deps);
    expect(result).toMatchObject({ ok: true, status: "failed", errorDetail: "quota" });
  });

  it("falls back to the error code when the failure has no detail", async () => {
    const { deps } = makeDeps({
      ingest: vi.fn().mockResolvedValue({ ok: false, error: "model_error" })
    });
    const result = await importZoomTranscriptDocument(PARAMS, deps);
    expect(result).toMatchObject({ ok: true, status: "failed", errorDetail: "model_error" });
  });
});

/**
 * Zoom's default topics collide, so the provisional title (built from that
 * topic before ingest) is replaced once the minutes exist and reveal who was
 * on the call and what it was about.
 */
describe("importZoomTranscriptDocument, derived title", () => {
  const GUEST_VTT = [
    "WEBVTT",
    "",
    "1",
    "00:00:01.000 --> 00:00:03.000",
    "Brian Lane: Thanks for jumping on.",
    "",
    "2",
    "00:00:04.000 --> 00:00:06.000",
    "Alexander: Happy to be here."
  ].join("\n");

  const MINUTES = ["### Platform & Product Overview", "", "- Pricing", "", "## Transcript"].join("\n");

  it("retitles from the guest and the first minutes heading", async () => {
    const { deps } = makeDeps({
      ingest: vi.fn().mockResolvedValue({
        ok: true,
        contentMd: MINUTES,
        summary: 'Brian Lane and Alexander ("Bobby") walked the platform.'
      })
    });
    const result = await importZoomTranscriptDocument(
      {
        ...PARAMS,
        vtt: GUEST_VTT,
        title: "New Coworker's Zoom Meeting (transcript)",
        hostNames: ["Brian Lane", "New Coworker"]
      },
      deps
    );

    const d = deps as { patchDocument: ReturnType<typeof vi.fn> };
    expect(d.patchDocument).toHaveBeenCalledWith(
      BIZ,
      DOC_ID,
      expect.objectContaining({
        title: "Bobby Platform & Product Overview Zoom meeting recording"
      })
    );
    expect(result).toMatchObject({ ok: true, status: "ready" });
    // The API response and the dashboard render from this row, so it must
    // carry the title that was actually written, not the insert-time one.
    expect(result).toMatchObject({
      ok: true,
      document: { title: "Bobby Platform & Product Overview Zoom meeting recording" }
    });
  });

  it("keeps a title the host actually chose", async () => {
    const { deps } = makeDeps({
      ingest: vi
        .fn()
        .mockResolvedValue({ ok: true, contentMd: MINUTES, summary: "recap" })
    });
    await importZoomTranscriptDocument(
      {
        ...PARAMS,
        vtt: GUEST_VTT,
        title: "KYP onboarding call (transcript)",
        hostNames: ["Brian Lane"]
      },
      deps
    );
    const d = deps as { patchDocument: ReturnType<typeof vi.fn> };
    expect(d.patchDocument.mock.calls[0][2]).not.toHaveProperty("title");
  });

  it("returns the insert row unchanged when no title was derived", async () => {
    const { deps } = makeDeps({
      ingest: vi.fn().mockResolvedValue({ ok: true, contentMd: "", summary: null })
    });
    const result = await importZoomTranscriptDocument(
      { ...PARAMS, vtt: "WEBVTT\n\n", title: "Team sync (transcript)" },
      deps
    );
    expect(result).toMatchObject({ ok: true, document: { title: DOC_ROW.title } });
  });

  it("keeps the provisional title when nothing can be derived", async () => {
    const { deps } = makeDeps({
      ingest: vi.fn().mockResolvedValue({ ok: true, contentMd: "", summary: null })
    });
    await importZoomTranscriptDocument(
      {
        ...PARAMS,
        vtt: "WEBVTT\n\n",
        title: "Zoom meeting recording (transcript)",
        hostNames: ["Brian Lane"]
      },
      deps
    );
    const d = deps as { patchDocument: ReturnType<typeof vi.fn> };
    expect(d.patchDocument.mock.calls[0][2]).not.toHaveProperty("title");
  });
});

describe("resolveHostNames", () => {
  it("adds the Zoom account display name to the business name", async () => {
    await expect(
      resolveHostNames("New Coworker", async () => ({ account_name: "Brian Lane" }))
    ).resolves.toEqual(["New Coworker", "Brian Lane"]);
  });

  it("falls back to the business name when there is no connection", async () => {
    await expect(resolveHostNames("New Coworker", async () => null)).resolves.toEqual([
      "New Coworker"
    ]);
  });

  // A nicer document title is never worth failing an import over.
  it("never throws when the connection lookup does", async () => {
    await expect(
      resolveHostNames("New Coworker", async () => {
        throw new Error("db down");
      })
    ).resolves.toEqual(["New Coworker"]);
    await expect(
      resolveHostNames("New Coworker", async () => {
        throw "string boom";
      })
    ).resolves.toEqual(["New Coworker"]);
  });
});

describe("importZoomTranscriptDocument, the meeting classification hand-off", () => {
  it("schedules the classification with what the pass needs", async () => {
    const { deps } = makeDeps();
    await importZoomTranscriptDocument(
      { ...PARAMS, meetingUuid: MEETING_UUID, zoomMeetingId: "89815540862", hostNames: ["Acme Spa"] },
      deps
    );
    const d = deps as { scheduleClassification: ReturnType<typeof vi.fn> };
    expect(d.scheduleClassification).toHaveBeenCalledTimes(1);
    expect(d.scheduleClassification.mock.calls[0][0]).toMatchObject({
      businessId: BIZ,
      documentId: DOC_ID,
      content: "## Minutes",
      summary: "Short recap",
      meetingUuid: MEETING_UUID,
      zoomMeetingId: "89815540862",
      hostNames: ["Acme Spa"]
    });
  });

  it("files the document but classifies nothing without a meeting uuid", async () => {
    // A legacy reference shape that resolves no past-meeting UUID has
    // nothing to stamp, so a retry could not be told from a first run and
    // would duplicate the note and the to-dos.
    const { deps } = makeDeps();
    const out = await importZoomTranscriptDocument({ ...PARAMS, zoomMeetingId: null }, deps);
    expect(out.ok).toBe(true);
    expect((deps as { scheduleClassification: ReturnType<typeof vi.fn> }).scheduleClassification)
      .not.toHaveBeenCalled();
  });

  it("hands over the DERIVED title, which is what the document ends up called", async () => {
    const { deps } = makeDeps({
      ingest: vi.fn().mockResolvedValue({
        ok: true,
        contentMd: "## Discovery call\n\nNotes",
        summary: "Recap"
      })
    });
    await importZoomTranscriptDocument(
      {
        ...PARAMS,
        title: "Zoom meeting recording (transcript)",
        meetingUuid: MEETING_UUID,
        hostNames: ["Acme Spa"]
      },
      deps
    );
    const handed = (deps as { scheduleClassification: ReturnType<typeof vi.fn> })
      .scheduleClassification.mock.calls[0][0];
    expect(handed.documentTitle).toContain("Discovery call");
  });

  it("defaults the optional identifiers when the caller omits them", async () => {
    const { deps } = makeDeps();
    await importZoomTranscriptDocument({ ...PARAMS, meetingUuid: MEETING_UUID }, deps);
    expect(
      (deps as { scheduleClassification: ReturnType<typeof vi.fn> }).scheduleClassification.mock
        .calls[0][0]
    ).toMatchObject({ zoomMeetingId: null, hostNames: [] });
  });

  it("does not classify a transcript whose condensation failed", async () => {
    const { deps } = makeDeps({
      ingest: vi.fn().mockResolvedValue({ ok: false, error: "summarizer_failed" })
    });
    await importZoomTranscriptDocument({ ...PARAMS, meetingUuid: MEETING_UUID }, deps);
    expect((deps as { scheduleClassification: ReturnType<typeof vi.fn> }).scheduleClassification)
      .not.toHaveBeenCalled();
  });
});
