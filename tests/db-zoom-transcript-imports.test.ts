/**
 * Tests for the Zoom transcript-import dedupe ledger
 * (src/lib/db/zoom-transcript-imports.ts): claim/duplicate/steal semantics,
 * the manual-path row inspector, and the best-effort release/finalize paths
 * that never throw.
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
  getZoomTranscriptImport,
  claimZoomTranscriptClassification,
  getZoomTranscriptClassification,
  getZoomTranscriptImportByDocument,
  reopenZoomTranscriptClassification,
  reclaimCompletedZoomTranscriptImport,
  releaseZoomTranscriptImport,
  stampZoomTranscriptClassification,
  ZOOM_IMPORT_CLAIM_LEASE_MS
} from "@/lib/db/zoom-transcript-imports";

const BIZ = "11111111-1111-4111-8111-111111111111";
const UUID = "jhqVQlf1RyuEX/1TCRs+Jg==";
const DOC = "22222222-2222-4222-8222-222222222222";
const NOW = 1_800_000_000_000;

type Chain = {
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  not: ReturnType<typeof vi.fn>;
  lt: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function chain(terminal: unknown): Chain & PromiseLike<unknown> {
  const c = {
    insert: vi.fn(() => c),
    update: vi.fn(() => c),
    delete: vi.fn(() => c),
    select: vi.fn(() => c),
    match: vi.fn(() => c),
    is: vi.fn(() => c),
    not: vi.fn(() => c),
    lt: vi.fn(() => c),
    maybeSingle: vi.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve)
  };
  return c as never;
}

/** Each db.from() call consumes the next chain (claim runs two queries). */
function makeDb(...chains: unknown[]) {
  let i = 0;
  return { from: vi.fn(() => chains[Math.min(i++, chains.length - 1)]) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  defaultClientSpy.mockReset();
});

const DUP = { error: { code: "23505", message: "duplicate key" } };

describe("claimZoomTranscriptImport", () => {
  it("returns true when the claim inserts", async () => {
    const c = chain({ error: null });
    expect(await claimZoomTranscriptImport(BIZ, UUID, makeDb(c))).toBe(true);
    expect(c.insert).toHaveBeenCalledWith({ business_id: BIZ, meeting_uuid: UUID });
  });

  it("returns false when a FRESH in-flight claim holds the slot", async () => {
    const steal = chain({ data: [], error: null });
    expect(await claimZoomTranscriptImport(BIZ, UUID, makeDb(chain(DUP), steal))).toBe(false);
    expect(steal.is).toHaveBeenCalledWith("document_id", null);
  });

  it("steals an ABANDONED in-flight claim past the lease window", async () => {
    const steal = chain({ data: [{ id: "row-1" }], error: null });
    expect(
      await claimZoomTranscriptImport(BIZ, UUID, makeDb(chain(DUP), steal), () => NOW)
    ).toBe(true);
    expect(steal.update).toHaveBeenCalledWith({
      created_at: new Date(NOW).toISOString()
    });
    expect(steal.lt).toHaveBeenCalledWith(
      "created_at",
      new Date(NOW - ZOOM_IMPORT_CLAIM_LEASE_MS).toISOString()
    );
    expect(steal.match).toHaveBeenCalledWith({ business_id: BIZ, meeting_uuid: UUID });
  });

  it("treats a null steal payload as not stolen", async () => {
    const steal = chain({ data: null, error: null });
    expect(await claimZoomTranscriptImport(BIZ, UUID, makeDb(chain(DUP), steal))).toBe(false);
  });

  it("throws on non-duplicate insert errors and on steal errors", async () => {
    const c = chain({ error: { code: "42P01", message: "no such table" } });
    await expect(claimZoomTranscriptImport(BIZ, UUID, makeDb(c))).rejects.toThrow(
      /no such table/
    );

    const steal = chain({ data: null, error: { message: "steal denied" } });
    await expect(
      claimZoomTranscriptImport(BIZ, UUID, makeDb(chain(DUP), steal))
    ).rejects.toThrow(/steal denied/);
  });

  it("uses the default service client when none is provided", async () => {
    const c = chain({ error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await claimZoomTranscriptImport(BIZ, UUID)).toBe(true);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("getZoomTranscriptImport", () => {
  it("returns the row when present", async () => {
    const c = chain(null);
    c.maybeSingle.mockResolvedValue({
      data: { document_id: DOC, created_at: "2026-07-24T00:00:00Z" },
      error: null
    });
    expect(await getZoomTranscriptImport(BIZ, UUID, makeDb(c))).toEqual({
      document_id: DOC,
      created_at: "2026-07-24T00:00:00Z"
    });
    expect(c.match).toHaveBeenCalledWith({ business_id: BIZ, meeting_uuid: UUID });
  });

  it("returns null when no row exists", async () => {
    const c = chain(null);
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getZoomTranscriptImport(BIZ, UUID, makeDb(c))).toBeNull();
  });

  it("throws on a query error", async () => {
    const c = chain(null);
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "read boom" } });
    await expect(getZoomTranscriptImport(BIZ, UUID, makeDb(c))).rejects.toThrow(/read boom/);
  });

  it("uses the default service client when none is provided", async () => {
    const c = chain(null);
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await getZoomTranscriptImport(BIZ, UUID)).toBeNull();
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
  it("stamps the produced document onto the claim and reports success", async () => {
    const c = chain({ data: [{ id: "row-1" }], error: null });
    expect(await finalizeZoomTranscriptImport(BIZ, UUID, DOC, makeDb(c))).toBe(true);
    expect(c.update).toHaveBeenCalledWith({ document_id: DOC });
    expect(c.match).toHaveBeenCalledWith({ business_id: BIZ, meeting_uuid: UUID });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports failure when no ledger row matched (claim vanished)", async () => {
    const c = chain({ data: [], error: null });
    expect(await finalizeZoomTranscriptImport(BIZ, UUID, DOC, makeDb(c))).toBe(false);

    const c2 = chain({ data: null, error: null });
    expect(await finalizeZoomTranscriptImport(BIZ, UUID, DOC, makeDb(c2))).toBe(false);
  });

  it("logs a query error and reports failure instead of throwing", async () => {
    const c = chain({ error: { message: "update denied" } });
    expect(await finalizeZoomTranscriptImport(BIZ, UUID, DOC, makeDb(c))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "zoom transcript ledger: finalize failed",
      expect.objectContaining({ error: "update denied" })
    );
  });

  it("skips the write when the service client is unavailable", async () => {
    defaultClientSpy.mockImplementation(() => {
      throw new Error("db down");
    });
    expect(await finalizeZoomTranscriptImport(BIZ, UUID, DOC)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "zoom transcript ledger: finalize client unavailable",
      expect.objectContaining({ error: "db down" })
    );
  });
});

describe("reclaimCompletedZoomTranscriptImport", () => {
  it("flips a completed row back to in-flight and reports the win", async () => {
    const c = chain({ data: [{ id: "row-1" }], error: null });
    expect(
      await reclaimCompletedZoomTranscriptImport(BIZ, UUID, makeDb(c), () => NOW)
    ).toBe(true);
    expect(c.update).toHaveBeenCalledWith({
      document_id: null,
      created_at: new Date(NOW).toISOString()
    });
    expect(c.not).toHaveBeenCalledWith("document_id", "is", null);
    expect(c.match).toHaveBeenCalledWith({ business_id: BIZ, meeting_uuid: UUID });
  });

  it("reports a lost race (row already in-flight or gone)", async () => {
    const c = chain({ data: [], error: null });
    expect(await reclaimCompletedZoomTranscriptImport(BIZ, UUID, makeDb(c))).toBe(false);

    const c2 = chain({ data: null, error: null });
    expect(await reclaimCompletedZoomTranscriptImport(BIZ, UUID, makeDb(c2))).toBe(false);
  });

  it("throws on a query error", async () => {
    const c = chain({ data: null, error: { message: "reclaim denied" } });
    await expect(
      reclaimCompletedZoomTranscriptImport(BIZ, UUID, makeDb(c))
    ).rejects.toThrow(/reclaim denied/);
  });

  it("uses the default service client when none is provided", async () => {
    const c = chain({ data: [], error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await reclaimCompletedZoomTranscriptImport(BIZ, UUID)).toBe(false);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("getZoomTranscriptClassification", () => {
  const CONTACT = "33333333-3333-4333-8333-333333333333";

  it("returns the stored decision once a classification has run", async () => {
    const c = chain(null);
    c.maybeSingle.mockResolvedValue({
      data: { contact_id: CONTACT, outcome: "signed", classified_at: "2026-08-20T21:00:00Z" },
      error: null
    });
    expect(await getZoomTranscriptClassification(BIZ, UUID, makeDb(c))).toEqual({
      contactId: CONTACT,
      outcome: "signed",
      classifiedAt: "2026-08-20T21:00:00Z"
    });
    expect(c.match).toHaveBeenCalledWith({ business_id: BIZ, meeting_uuid: UUID });
  });

  it("reads an unclassified row as not yet decided", async () => {
    // The import ledger row exists from the claim; only classified_at says
    // whether the side effects have run.
    const c = chain(null);
    c.maybeSingle.mockResolvedValue({
      data: { contact_id: null, outcome: null, classified_at: null },
      error: null
    });
    expect(await getZoomTranscriptClassification(BIZ, UUID, makeDb(c))).toBeNull();
  });

  it("returns null when there is no row at all", async () => {
    const c = chain(null);
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getZoomTranscriptClassification(BIZ, UUID, makeDb(c))).toBeNull();
  });

  it("reads an error as not yet decided, and never throws", async () => {
    // Fail-open on purpose: the cost of being wrong here is a duplicate
    // note, and the caller's own writes are individually guarded.
    const c = chain(null);
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "read boom" } });
    expect(await getZoomTranscriptClassification(BIZ, UUID, makeDb(c))).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("stays silent when the service client cannot be built", async () => {
    defaultClientSpy.mockImplementation(() => {
      throw new Error("no env");
    });
    expect(await getZoomTranscriptClassification(BIZ, UUID)).toBeNull();
  });
});

describe("claimZoomTranscriptClassification", () => {
  const NOW_FN = () => NOW;

  it("wins the claim when the row is unclassified", async () => {
    const c = chain({ data: [{ id: "row-1" }], error: null });
    expect(await claimZoomTranscriptClassification(BIZ, UUID, makeDb(c), NOW_FN)).toBe(true);
    expect(c.update).toHaveBeenCalledWith({ classified_at: new Date(NOW).toISOString() });
    // The conditional is the whole point: only a row still at null matches,
    // so two racing passes cannot both win.
    expect(c.is).toHaveBeenCalledWith("classified_at", null);
    expect(c.match).toHaveBeenCalledWith({ business_id: BIZ, meeting_uuid: UUID });
  });

  it("loses the claim when another pass already owns the meeting", async () => {
    const c = chain({ data: [], error: null });
    expect(await claimZoomTranscriptClassification(BIZ, UUID, makeDb(c), NOW_FN)).toBe(false);
  });

  it("declines rather than risking a duplicate when the ledger errors", async () => {
    const c = chain({ data: null, error: { message: "claim boom" } });
    expect(await claimZoomTranscriptClassification(BIZ, UUID, makeDb(c), NOW_FN)).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("declines when no data comes back at all", async () => {
    const c = chain({ data: null, error: null });
    expect(await claimZoomTranscriptClassification(BIZ, UUID, makeDb(c), NOW_FN)).toBe(false);
  });

  it("stays silent when the service client cannot be built", async () => {
    defaultClientSpy.mockImplementation(() => {
      throw new Error("no env");
    });
    expect(await claimZoomTranscriptClassification(BIZ, UUID)).toBe(false);
  });
});

describe("stampZoomTranscriptClassification", () => {
  const CONTACT = "33333333-3333-4333-8333-333333333333";

  it("records the contact and the outcome, leaving the claim marker alone", async () => {
    // classified_at belongs to the CLAIM, which set it before this pass ran.
    // Rewriting it here would turn an ownership marker into a completion
    // stamp and lose the "claimed but died" state.
    const c = chain({ error: null });
    await stampZoomTranscriptClassification(
      BIZ,
      UUID,
      { contactId: CONTACT, outcome: "signed" },
      makeDb(c)
    );
    expect(c.update).toHaveBeenCalledWith({ contact_id: CONTACT, outcome: "signed" });
    expect(c.match).toHaveBeenCalledWith({ business_id: BIZ, meeting_uuid: UUID });
  });

  it("stamps an unattributed decision too", async () => {
    // "We have decided about this meeting" is the fact being stored, not
    // "we changed something": without it a re-import would re-decide.
    const c = chain({ error: null });
    await stampZoomTranscriptClassification(
      BIZ,
      UUID,
      { contactId: null, outcome: "unclear" },
      makeDb(c)
    );
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({ contact_id: null, outcome: "unclear" })
    );
  });

  it("never throws on a write error", async () => {
    const c = chain({ error: { message: "stamp boom" } });
    await expect(
      stampZoomTranscriptClassification(
        BIZ,
        UUID,
        { contactId: null, outcome: "unclear" },
        makeDb(c)
      )
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("stays silent when the service client cannot be built", async () => {
    defaultClientSpy.mockImplementation(() => {
      throw new Error("no env");
    });
    await expect(
      stampZoomTranscriptClassification(BIZ, UUID, { contactId: null, outcome: "unclear" })
    ).resolves.toBeUndefined();
  });
});

describe("getZoomTranscriptImportByDocument", () => {
  it("recovers the meeting key from the document the import produced", async () => {
    const c = chain(null);
    c.maybeSingle.mockResolvedValue({
      data: { meeting_uuid: UUID, contact_id: null, outcome: "unclear" },
      error: null
    });
    await expect(getZoomTranscriptImportByDocument(BIZ, DOC, makeDb(c))).resolves.toEqual({
      meeting_uuid: UUID,
      contact_id: null,
      outcome: "unclear"
    });
    expect(c.match).toHaveBeenCalledWith({ business_id: BIZ, document_id: DOC });
  });

  it("answers null for a document that is not a Zoom import", async () => {
    const c = chain(null);
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(getZoomTranscriptImportByDocument(BIZ, DOC, makeDb(c))).resolves.toBeNull();
  });

  it("answers null and warns on a read error rather than throwing", async () => {
    const c = chain(null);
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getZoomTranscriptImportByDocument(BIZ, DOC, makeDb(c))).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("answers null when the service client cannot be built", async () => {
    defaultClientSpy.mockImplementation(() => {
      throw new Error("no env");
    });
    await expect(getZoomTranscriptImportByDocument(BIZ, DOC)).resolves.toBeNull();
  });
});

describe("reopenZoomTranscriptClassification", () => {
  it("clears a stamp that is now provably about the wrong person", async () => {
    const c = chain({ data: [{ id: "row-1" }], error: null });
    expect(await reopenZoomTranscriptClassification(BIZ, UUID, makeDb(c))).toBe(true);
    expect(c.update).toHaveBeenCalledWith({ classified_at: null, outcome: null });
    // Conditional on the stamp being SET: that is what makes the answer mean
    // "there was something to clear" rather than "I cleared it".
    expect(c.not).toHaveBeenCalledWith("classified_at", "is", null);
  });

  it("answers false when there was no stamp to clear", async () => {
    const c = chain({ data: [], error: null });
    expect(await reopenZoomTranscriptClassification(BIZ, UUID, makeDb(c))).toBe(false);
  });

  it("treats a null payload as nothing cleared", async () => {
    const c = chain({ data: null, error: null });
    expect(await reopenZoomTranscriptClassification(BIZ, UUID, makeDb(c))).toBe(false);
  });

  it("answers false and warns on an update error", async () => {
    const c = chain({ data: null, error: { message: "boom" } });
    expect(await reopenZoomTranscriptClassification(BIZ, UUID, makeDb(c))).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("answers false when the service client cannot be built", async () => {
    defaultClientSpy.mockImplementation(() => {
      throw new Error("no env");
    });
    await expect(reopenZoomTranscriptClassification(BIZ, UUID)).resolves.toBe(false);
  });
});
