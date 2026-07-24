/**
 * Tests for the Zoom transcript-import dedupe ledger
 * (src/lib/db/zoom-transcript-imports.ts): claim/duplicate semantics and
 * the best-effort release/finalize/manual-record paths that never throw.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import { logger } from "@/lib/logger";
import {
  claimZoomTranscriptImport,
  finalizeZoomTranscriptImport,
  recordManualZoomTranscriptImport,
  releaseZoomTranscriptImport
} from "@/lib/db/zoom-transcript-imports";

const BIZ = "11111111-1111-4111-8111-111111111111";
const UUID = "jhqVQlf1RyuEX/1TCRs+Jg==";
const DOC = "22222222-2222-4222-8222-222222222222";

type Chain = {
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
};

function chain(terminal: unknown): Chain & PromiseLike<unknown> {
  const c = {
    insert: vi.fn(() => c),
    update: vi.fn(() => c),
    delete: vi.fn(() => c),
    match: vi.fn(() => c),
    is: vi.fn(() => c),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve)
  };
  return c as never;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  defaultClientSpy.mockReset();
});

describe("claimZoomTranscriptImport", () => {
  it("returns true when the claim inserts", async () => {
    const c = chain({ error: null });
    expect(await claimZoomTranscriptImport(BIZ, UUID, makeDb(c))).toBe(true);
    expect(c.insert).toHaveBeenCalledWith({ business_id: BIZ, meeting_uuid: UUID });
  });

  it("returns false on a unique violation (someone already holds it)", async () => {
    const c = chain({ error: { code: "23505", message: "duplicate key" } });
    expect(await claimZoomTranscriptImport(BIZ, UUID, makeDb(c))).toBe(false);
  });

  it("throws on any other insert error", async () => {
    const c = chain({ error: { code: "42P01", message: "no such table" } });
    await expect(claimZoomTranscriptImport(BIZ, UUID, makeDb(c))).rejects.toThrow(
      /no such table/
    );
  });

  it("uses the default service client when none is provided", async () => {
    const c = chain({ error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await claimZoomTranscriptImport(BIZ, UUID)).toBe(true);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("releaseZoomTranscriptImport", () => {
  it("deletes only an in-flight claim (document_id null)", async () => {
    const c = chain({ error: null });
    await releaseZoomTranscriptImport(BIZ, UUID, makeDb(c));
    expect(c.delete).toHaveBeenCalled();
    expect(c.match).toHaveBeenCalledWith({ business_id: BIZ, meeting_uuid: UUID });
    expect(c.is).toHaveBeenCalledWith("document_id", null);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs a query error instead of throwing", async () => {
    const c = chain({ error: { message: "delete denied" } });
    await releaseZoomTranscriptImport(BIZ, UUID, makeDb(c));
    expect(logger.warn).toHaveBeenCalledWith(
      "zoom transcript ledger: release failed",
      expect.objectContaining({ error: "delete denied" })
    );
  });

  it("resolves the default service client when none is provided", async () => {
    const c = chain({ error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await releaseZoomTranscriptImport(BIZ, UUID);
    expect(c.delete).toHaveBeenCalled();
  });

  it("skips the write when the service client is unavailable (Error and non-Error)", async () => {
    defaultClientSpy.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(releaseZoomTranscriptImport(BIZ, UUID)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "zoom transcript ledger: release client unavailable",
      expect.objectContaining({ error: "db down" })
    );

    defaultClientSpy.mockImplementation(() => {
      throw "string down";
    });
    await expect(releaseZoomTranscriptImport(BIZ, UUID)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "zoom transcript ledger: release client unavailable",
      expect.objectContaining({ error: "string down" })
    );
  });
});

describe("finalizeZoomTranscriptImport", () => {
  it("stamps the produced document onto the claim", async () => {
    const c = chain({ error: null });
    await finalizeZoomTranscriptImport(BIZ, UUID, DOC, makeDb(c));
    expect(c.update).toHaveBeenCalledWith({ document_id: DOC });
    expect(c.match).toHaveBeenCalledWith({ business_id: BIZ, meeting_uuid: UUID });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs a query error instead of throwing", async () => {
    const c = chain({ error: { message: "update denied" } });
    await finalizeZoomTranscriptImport(BIZ, UUID, DOC, makeDb(c));
    expect(logger.warn).toHaveBeenCalledWith(
      "zoom transcript ledger: finalize failed",
      expect.objectContaining({ error: "update denied" })
    );
  });

  it("skips the write when the service client is unavailable", async () => {
    defaultClientSpy.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(finalizeZoomTranscriptImport(BIZ, UUID, DOC)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "zoom transcript ledger: finalize client unavailable",
      expect.objectContaining({ error: "db down" })
    );
  });
});

describe("recordManualZoomTranscriptImport", () => {
  it("records the manual import with its document", async () => {
    const c = chain({ error: null });
    await recordManualZoomTranscriptImport(BIZ, UUID, DOC, makeDb(c));
    expect(c.insert).toHaveBeenCalledWith({
      business_id: BIZ,
      meeting_uuid: UUID,
      document_id: DOC
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("treats a unique violation as already-recorded (no warning)", async () => {
    const c = chain({ error: { code: "23505", message: "duplicate key" } });
    await recordManualZoomTranscriptImport(BIZ, UUID, DOC, makeDb(c));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs other insert errors instead of throwing", async () => {
    const c = chain({ error: { code: "42P01", message: "no such table" } });
    await recordManualZoomTranscriptImport(BIZ, UUID, DOC, makeDb(c));
    expect(logger.warn).toHaveBeenCalledWith(
      "zoom transcript ledger: manual record failed",
      expect.objectContaining({ error: "no such table" })
    );
  });

  it("skips the write when the service client is unavailable", async () => {
    defaultClientSpy.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(recordManualZoomTranscriptImport(BIZ, UUID, DOC)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "zoom transcript ledger: manual record client unavailable",
      expect.objectContaining({ error: "db down" })
    );
  });
});
