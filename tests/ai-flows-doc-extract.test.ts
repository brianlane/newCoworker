import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDocExtractionPrompt,
  DOC_EXTRACT_MAX_BYTES,
  docExtract,
  documentMimeForPath,
  parseDocumentRef,
  parseDocExtractionReply
} from "@/lib/ai-flows/doc-extract";
import { GeminiEmptyError } from "@/lib/gemini-generate-content";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/billing/ai-spend-meter", () => ({
  meterGeminiSpendForBusiness: vi.fn(async () => undefined)
}));
vi.mock("@/lib/documents/db", () => ({
  countBusinessDocuments: vi.fn(async () => 0),
  insertBusinessDocument: vi.fn(async () => ({})),
  patchBusinessDocument: vi.fn(async () => undefined)
}));
vi.mock("@/lib/documents/ingest", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/documents/ingest")>();
  return {
    ...original,
    ingestDocument: vi.fn(async () => ({ ok: true, contentMd: "# doc", summary: "a doc" }))
  };
});

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import {
  countBusinessDocuments,
  insertBusinessDocument,
  patchBusinessDocument
} from "@/lib/documents/db";
import { ingestDocument } from "@/lib/documents/ingest";

const BIZ = "00000000-0000-0000-0000-000000000001";
const PDF_REF = "email-attachments:inbound/msg1/0-renewal.pdf";

type StorageResult = { data: Blob | null; error: { message: string } | null };

/**
 * Service-client fake: storage download/upload/remove, the email_log
 * ownership lookup, and the businesses tier read.
 */
function makeDb(opts: {
  download?: StorageResult;
  uploadError?: { message: string } | null;
  tier?: string | null;
  /** email_log ownership row (null = ref not on this tenant's mail). */
  ownerRow?: { id: string } | null;
  ownerLookupError?: { message: string } | null;
  removeError?: { message: string } | null;
  businessRow?: { tier?: string | null; name?: string | null } | null;
}) {
  const uploads: Array<{ bucket: string; path: string }> = [];
  const removes: Array<{ bucket: string; paths: string[] }> = [];
  const storageCalls: string[] = [];
  const ownershipCalls: Array<{ name: string; args: unknown[] }> = [];
  const db = {
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          storageCalls.push(`download:${bucket}/${path}`);
          return opts.download ?? { data: new Blob([Buffer.from("%PDF-1.4 fake")]), error: null };
        },
        upload: async (path: string) => {
          uploads.push({ bucket, path });
          return { error: opts.uploadError ?? null };
        },
        remove: async (paths: string[]) => {
          removes.push({ bucket, paths });
          return { error: opts.removeError ?? null };
        }
      })
    },
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "contains", "limit"]) {
        builder[m] = (...args: unknown[]) => {
          if (table === "email_log") ownershipCalls.push({ name: m, args });
          return builder;
        };
      }
      builder.maybeSingle = async () => {
        if (table === "email_log") {
          return {
            data: opts.ownerLookupError ? null : opts.ownerRow === undefined ? { id: "log-1" } : opts.ownerRow,
            error: opts.ownerLookupError ?? null
          };
        }
        return {
          data:
            opts.businessRow !== undefined
              ? opts.businessRow
              : { tier: opts.tier ?? "standard", name: "Acme" },
          error: null
        };
      };
      return builder;
    }
  };
  return { db, uploads, removes, storageCalls, ownershipCalls };
}

const okGenerate = vi.fn(async (_params: Record<string, unknown>) => ({
  text: '{"renewal_date": "2026-09-01", "premium": "$1,200"}',
  usage: { inputTokens: 10, outputTokens: 5 }
}));

const FIELDS = [{ name: "renewal_date" }, { name: "premium", description: "the premium" }];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_API_KEY = "test-key";
});

describe("parseDocumentRef", () => {
  it("accepts only sane email-attachments refs", () => {
    expect(parseDocumentRef(PDF_REF)).toEqual({
      bucket: "email-attachments",
      path: "inbound/msg1/0-renewal.pdf"
    });
    expect(parseDocumentRef("  email-attachments:a/b.txt ")).toEqual({
      bucket: "email-attachments",
      path: "a/b.txt"
    });
    expect(parseDocumentRef("business-docs:x.pdf")).toBeNull();
    expect(parseDocumentRef("email-attachments:")).toBeNull();
    expect(parseDocumentRef("email-attachments:/abs/path.pdf")).toBeNull();
    expect(parseDocumentRef("email-attachments:a/../b.pdf")).toBeNull();
    expect(parseDocumentRef("email-attachments:a\\b.pdf")).toBeNull();
    expect(parseDocumentRef(`email-attachments:${"a".repeat(501)}`)).toBeNull();
    expect(parseDocumentRef("junk")).toBeNull();
  });
});

describe("documentMimeForPath", () => {
  it("maps supported extensions and rejects everything else", () => {
    expect(documentMimeForPath("a/b/renewal.PDF")).toBe("application/pdf");
    expect(documentMimeForPath("notes.txt")).toBe("text/plain");
    expect(documentMimeForPath("readme.md")).toBe("text/markdown");
    expect(documentMimeForPath("rows.csv")).toBe("text/csv");
    expect(documentMimeForPath("photo.jpg")).toBe("");
    expect(documentMimeForPath("no-extension")).toBe("");
  });
});

describe("buildDocExtractionPrompt / parseDocExtractionReply", () => {
  it("asks for exactly one JSON object naming every field", () => {
    const prompt = buildDocExtractionPrompt(FIELDS);
    expect(prompt).toContain('"renewal_date"');
    expect(prompt).toContain("the premium");
    expect(prompt).toContain("never invent");
  });

  it("parses fenced/prefixed replies, keeps only requested string fields", () => {
    const parsed = parseDocExtractionReply(
      '```json\n{"renewal_date": "2026-09-01", "premium": 1200, "extra": "x"}\n```',
      FIELDS
    );
    expect(parsed).toEqual({ renewal_date: "2026-09-01", premium: "" });
    expect(parseDocExtractionReply("no json here", FIELDS)).toBeNull();
    expect(parseDocExtractionReply("{broken", FIELDS)).toBeNull();
    // Braces present but invalid JSON inside → the parse catch.
    expect(parseDocExtractionReply('{"renewal_date": }', FIELDS)).toBeNull();
  });
});

describe("docExtract", () => {
  const input = { businessId: BIZ, sourceRef: PDF_REF, fields: FIELDS };

  it("downloads, extracts via Gemini (PDF inline), and meters the spend", async () => {
    const { db, storageCalls, ownershipCalls } = makeDb({});
    const result = await docExtract(input, { client: db as never, generate: okGenerate as never });
    expect(result).toEqual({
      ok: true,
      vars: { renewal_date: "2026-09-01", premium: "$1,200" },
      filed: null
    });
    expect(storageCalls).toEqual(["download:email-attachments/inbound/msg1/0-renewal.pdf"]);
    // The ownership gate keys on this tenant's email_log attachment paths.
    expect(
      ownershipCalls.some((c) => c.name === "eq" && c.args[0] === "business_id" && c.args[1] === BIZ)
    ).toBe(true);
    expect(
      ownershipCalls.some(
        (c) =>
          c.name === "contains" &&
          c.args[0] === "attachments" &&
          JSON.stringify(c.args[1]) ===
            JSON.stringify([{ storage_path: "inbound/msg1/0-renewal.pdf" }])
      )
    ).toBe(true);
    const call = okGenerate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.inlineParts).toEqual([
      { mimeType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64") }
    ]);
    expect(meterGeminiSpendForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, surface: "aiflow_doc_extract" })
    );
  });

  it("text documents ride in the prompt body, not inlineParts", async () => {
    const { db } = makeDb({
      download: { data: new Blob([Buffer.from("premium: $99")]), error: null }
    });
    await docExtract(
      { ...input, sourceRef: "email-attachments:inbound/m/0-notes.txt" },
      { client: db as never, generate: okGenerate as never }
    );
    const call = okGenerate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.inlineParts).toBeUndefined();
    expect(call.userText).toContain("premium: $99");
  });

  it("permanent input problems: bad ref / type / missing / empty / oversized", async () => {
    const { db } = makeDb({});
    expect(await docExtract({ ...input, sourceRef: "junk" }, { client: db as never })).toMatchObject(
      { ok: false, error: "unsupported_ref" }
    );
    expect(
      await docExtract(
        { ...input, sourceRef: "email-attachments:inbound/m/0-photo.jpg" },
        { client: db as never }
      )
    ).toMatchObject({ ok: false, error: "unsupported_type" });

    const missing = makeDb({ download: { data: null, error: { message: "404" } } });
    expect(await docExtract(input, { client: missing.db as never })).toMatchObject({
      ok: false,
      error: "not_found",
      detail: "404"
    });
    const missingNoDetail = makeDb({ download: { data: null, error: null } });
    expect(await docExtract(input, { client: missingNoDetail.db as never })).toMatchObject({
      ok: false,
      error: "not_found"
    });

    const empty = makeDb({ download: { data: new Blob([]), error: null } });
    expect(await docExtract(input, { client: empty.db as never })).toMatchObject({
      ok: false,
      error: "empty_document"
    });

    const big = makeDb({
      download: { data: new Blob([Buffer.alloc(DOC_EXTRACT_MAX_BYTES + 1)]), error: null }
    });
    expect(await docExtract(input, { client: big.db as never })).toMatchObject({
      ok: false,
      error: "too_large"
    });
  });

  it("ownership gate: a ref not on this tenant's mail fails CLOSED as not_found", async () => {
    const { db, storageCalls } = makeDb({ ownerRow: null });
    expect(
      await docExtract(input, { client: db as never, generate: okGenerate as never })
    ).toMatchObject({ ok: false, error: "not_found", detail: "document not on this business's mailbox" });
    // The bytes are never even downloaded.
    expect(storageCalls).toEqual([]);
  });

  it("ownership gate: a lookup fault THROWS (retry) instead of failing open", async () => {
    const { db } = makeDb({ ownerLookupError: { message: "db down" } });
    await expect(
      docExtract(input, { client: db as never, generate: okGenerate as never })
    ).rejects.toThrow("doc-extract ownership lookup: db down");
  });

  it("no API key → extractor_unavailable", async () => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const { db } = makeDb({});
    expect(await docExtract(input, { client: db as never })).toMatchObject({
      ok: false,
      error: "extractor_unavailable"
    });
  });

  it("an empty model reply meters the thinking spend then fails permanently", async () => {
    const { db } = makeDb({});
    const emptyGenerate = vi.fn(async () => {
      throw new GeminiEmptyError({ inputTokens: 9, outputTokens: 3 } as never);
    });
    expect(
      await docExtract(input, { client: db as never, generate: emptyGenerate as never })
    ).toMatchObject({ ok: false, error: "extraction_failed", detail: "empty model reply" });
    expect(meterGeminiSpendForBusiness).toHaveBeenCalled();
  });

  it("transport faults rethrow (the route 500s → worker retries)", async () => {
    const { db } = makeDb({});
    const boom = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await expect(
      docExtract(input, { client: db as never, generate: boom as never })
    ).rejects.toThrow("fetch failed");
  });

  it("an unparseable reply is a permanent extraction failure", async () => {
    const { db } = makeDb({});
    const junkGenerate = vi.fn(async () => ({ text: "sorry, no", usage: {} }));
    expect(
      await docExtract(input, { client: db as never, generate: junkGenerate as never })
    ).toMatchObject({ ok: false, error: "extraction_failed" });
  });

  it("fileAs: copies the bytes, inserts the row, condenses, and reports the filing", async () => {
    const { db, uploads } = makeDb({});
    const result = await docExtract(
      { ...input, fileAs: { title: "Renewal — Acme", audience: "staff" } },
      { client: db as never, generate: okGenerate as never }
    );
    expect(result.ok && result.filed?.title).toBe("Renewal — Acme");
    expect(uploads[0].bucket).toBe("business-docs");
    // The index prefix the email worker adds is stripped from the filed name.
    expect(uploads[0].path).toMatch(/\/renewal\.pdf$/);
    expect(insertBusinessDocument).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Renewal — Acme", audience: "staff", category: "filed" }),
      expect.anything()
    );
    expect(ingestDocument).toHaveBeenCalled();
    expect(patchBusinessDocument).toHaveBeenCalledWith(
      BIZ,
      expect.any(String),
      expect.objectContaining({ status: "ready" }),
      expect.anything()
    );
  });

  it("a post-insert condense/patch THROW still reports the filed document", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb({});
    vi.mocked(ingestDocument).mockRejectedValueOnce(new Error("condense transport down"));
    const result = await docExtract(
      { ...input, fileAs: { title: "T", audience: "staff" } },
      { client: db as never, generate: okGenerate as never }
    );
    // The row + bytes exist, so downstream steps can still reference it.
    expect(result.ok && result.filed?.title).toBe("T");
    expect(result.ok && result.fileError).toBe("condense transport down");

    // Non-Error throws stringify.
    vi.mocked(ingestDocument).mockRejectedValueOnce("weird condense failure");
    const stringy = await docExtract(
      { ...input, fileAs: { title: "T", audience: "staff" } },
      { client: makeDb({}).db as never, generate: okGenerate as never }
    );
    expect(stringy.ok && stringy.filed?.title).toBe("T");
    expect(stringy.ok && stringy.fileError).toBe("weird condense failure");
    err.mockRestore();
  });

  it("a failed condense files the row as failed (the filing still stands)", async () => {
    const { db } = makeDb({});
    vi.mocked(ingestDocument).mockResolvedValueOnce({
      ok: false,
      error: "summarizer_failed",
      detail: "boom"
    });
    const result = await docExtract(
      { ...input, fileAs: { title: "T", audience: "both" } },
      { client: db as never, generate: okGenerate as never }
    );
    expect(result.ok && result.filed).toBeTruthy();
    expect(patchBusinessDocument).toHaveBeenCalledWith(
      BIZ,
      expect.any(String),
      expect.objectContaining({ status: "failed", error_detail: "boom" }),
      expect.anything()
    );

    // Detail-less ingest failures fall back to the error code.
    vi.mocked(ingestDocument).mockResolvedValueOnce({ ok: false, error: "empty_content" });
    await docExtract(
      { ...input, fileAs: { title: "T", audience: "both" } },
      { client: db as never, generate: okGenerate as never }
    );
    expect(patchBusinessDocument).toHaveBeenCalledWith(
      BIZ,
      expect.any(String),
      expect.objectContaining({ status: "failed", error_detail: "empty_content" }),
      expect.anything()
    );
  });

  it("a null business row still files (tier defaults, no business name)", async () => {
    const { db } = makeDb({ businessRow: null });
    const result = await docExtract(
      { ...input, fileAs: { title: "T", audience: "staff" } },
      { client: db as never, generate: okGenerate as never }
    );
    expect(result.ok && result.filed).toBeTruthy();
  });

  it("filing failures are non-fatal: cap reached, storage copy failed, insert threw", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const capped = makeDb({ tier: "starter" });
    vi.mocked(countBusinessDocuments).mockResolvedValueOnce(999);
    const atCap = await docExtract(
      { ...input, fileAs: { title: "T", audience: "staff" } },
      { client: capped.db as never, generate: okGenerate as never }
    );
    expect(atCap).toMatchObject({
      ok: true,
      filed: null,
      fileError: "document limit reached for your plan"
    });

    const badCopy = makeDb({ uploadError: { message: "bucket down" } });
    const copyFail = await docExtract(
      { ...input, fileAs: { title: "T", audience: "staff" } },
      { client: badCopy.db as never, generate: okGenerate as never }
    );
    expect(copyFail).toMatchObject({ ok: true, filed: null });
    expect(copyFail.ok && copyFail.fileError).toContain("bucket down");

    vi.mocked(insertBusinessDocument).mockRejectedValueOnce(new Error("insert down"));
    const { db, removes } = makeDb({});
    const insertFail = await docExtract(
      { ...input, fileAs: { title: "T", audience: "staff" } },
      { client: db as never, generate: okGenerate as never }
    );
    expect(insertFail).toMatchObject({ ok: true, filed: null, fileError: "insert down" });
    // Compensating remove: the failed insert must not orphan the uploaded object.
    expect(removes).toHaveLength(1);
    expect(removes[0].bucket).toBe("business-docs");
    expect(removes[0].paths[0]).toMatch(/\/renewal\.pdf$/);

    // A cleanup failure is logged but never masks the original error.
    vi.mocked(insertBusinessDocument).mockRejectedValueOnce(new Error("insert down"));
    const badCleanup = makeDb({ removeError: { message: "remove down" } });
    const cleanupFail = await docExtract(
      { ...input, fileAs: { title: "T", audience: "staff" } },
      { client: badCleanup.db as never, generate: okGenerate as never }
    );
    expect(cleanupFail).toMatchObject({ ok: true, filed: null, fileError: "insert down" });

    // Non-Error throws stringify.
    vi.mocked(insertBusinessDocument).mockRejectedValueOnce("weird failure");
    const stringFail = await docExtract(
      { ...input, fileAs: { title: "T", audience: "staff" } },
      { client: makeDb({}).db as never, generate: okGenerate as never }
    );
    expect(stringFail).toMatchObject({ ok: true, filed: null, fileError: "weird failure" });
    err.mockRestore();
  });

  it("creates a service client when none is passed", async () => {
    const { db } = makeDb({});
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const result = await docExtract(input, { generate: okGenerate as never });
    expect(result.ok).toBe(true);
  });
});
