import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/documents/db", () => ({
  getBusinessDocument: vi.fn()
}));

import { resolveFlowDocumentSource } from "@/lib/ai-flows/doc-source";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusinessDocument } from "@/lib/documents/db";

const BIZ = "00000000-0000-0000-0000-000000000001";
const DOC_ID = "22222222-2222-4222-8222-222222222222";
const DOC_REF = `business-docs:${DOC_ID}`;
const ATTACHMENT_REF = "email-attachments:inbound/msg1/0-quotes.pdf";

type Client = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

function makeDb(opts: {
  download?: { data: Blob | null; error: { message: string } | null };
  ownerRow?: { id: string } | null;
  ownerLookupError?: { message: string } | null;
} = {}) {
  const downloads: string[] = [];
  const db = {
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          downloads.push(`${bucket}/${path}`);
          return opts.download ?? { data: new Blob([Buffer.from("%PDF-1.4 fake")]), error: null };
        }
      })
    },
    from: () => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "contains", "limit"]) {
        builder[m] = () => builder;
      }
      builder.maybeSingle = async () => ({
        data: opts.ownerLookupError ? null : opts.ownerRow === undefined ? { id: "log-1" } : opts.ownerRow,
        error: opts.ownerLookupError ?? null
      });
      return builder;
    }
  };
  return { db, downloads };
}

function docRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    business_id: BIZ,
    title: "Carrier quotes",
    status: "ready",
    mime_type: "application/pdf",
    storage_path: `${BIZ}/${DOC_ID}/quotes.pdf`,
    ...overrides
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveFlowDocumentSource — business-docs refs", () => {
  it("resolves a ready document (tenant-scoped lookup is the ownership gate)", async () => {
    vi.mocked(getBusinessDocument).mockResolvedValue(docRow());
    const { db, downloads } = makeDb();
    const result = await resolveFlowDocumentSource(BIZ, ` ${DOC_REF} `, {
      client: db as unknown as Client
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toMatchObject({
        mimeType: "application/pdf",
        filename: "quotes.pdf",
        documentId: DOC_ID
      });
      expect(result.source.bytes.length).toBeGreaterThan(0);
    }
    expect(vi.mocked(getBusinessDocument).mock.calls[0].slice(0, 2)).toEqual([BIZ, DOC_ID]);
    expect(downloads).toEqual([`business-docs/${BIZ}/${DOC_ID}/quotes.pdf`]);
  });

  it("falls back to the document title when the stored path has no filename", async () => {
    vi.mocked(getBusinessDocument).mockResolvedValue(docRow({ storage_path: "" }));
    const { db } = makeDb();
    const result = await resolveFlowDocumentSource(BIZ, DOC_REF, {
      client: db as unknown as Client
    });
    expect(result.ok && result.source.filename).toBe("Carrier quotes");
  });

  it("reports a missing / not-ready / unsupported document as permanent", async () => {
    const { db } = makeDb();
    vi.mocked(getBusinessDocument).mockResolvedValue(null);
    expect(
      await resolveFlowDocumentSource(BIZ, DOC_REF, { client: db as unknown as Client })
    ).toMatchObject({ ok: false, error: "not_found" });

    vi.mocked(getBusinessDocument).mockResolvedValue(docRow({ status: "processing" }));
    expect(
      await resolveFlowDocumentSource(BIZ, DOC_REF, { client: db as unknown as Client })
    ).toMatchObject({ ok: false, error: "not_found", detail: "document is not ready to use" });

    vi.mocked(getBusinessDocument).mockResolvedValue(docRow({ mime_type: "image/png" }));
    expect(
      await resolveFlowDocumentSource(BIZ, DOC_REF, { client: db as unknown as Client })
    ).toMatchObject({ ok: false, error: "unsupported_type" });
  });

  it("reports storage failures, empty bytes, and oversize", async () => {
    vi.mocked(getBusinessDocument).mockResolvedValue(docRow());
    const download404 = makeDb({ download: { data: null, error: { message: "404" } } });
    expect(
      await resolveFlowDocumentSource(BIZ, DOC_REF, { client: download404.db as unknown as Client })
    ).toMatchObject({ ok: false, error: "not_found", detail: "404" });

    const noData = makeDb({ download: { data: null, error: null } });
    expect(
      await resolveFlowDocumentSource(BIZ, DOC_REF, { client: noData.db as unknown as Client })
    ).toMatchObject({ ok: false, error: "not_found", detail: "document missing from storage" });

    const emptyBlob = makeDb({ download: { data: new Blob([]), error: null } });
    expect(
      await resolveFlowDocumentSource(BIZ, DOC_REF, { client: emptyBlob.db as unknown as Client })
    ).toMatchObject({ ok: false, error: "empty_document" });

    const big = makeDb();
    expect(
      await resolveFlowDocumentSource(BIZ, DOC_REF, {
        client: big.db as unknown as Client,
        maxBytes: 3
      })
    ).toMatchObject({ ok: false, error: "too_large" });
  });
});

describe("resolveFlowDocumentSource — email-attachments refs", () => {
  it("resolves an owned attachment via the default service client", async () => {
    const { db, downloads } = makeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const result = await resolveFlowDocumentSource(BIZ, ATTACHMENT_REF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toMatchObject({
        mimeType: "application/pdf",
        filename: "quotes.pdf", // "0-" index prefix stripped
        documentId: null
      });
    }
    expect(downloads).toEqual(["email-attachments/inbound/msg1/0-quotes.pdf"]);
  });

  it("rejects unrecognized refs and unsupported extensions", async () => {
    const { db } = makeDb();
    expect(
      await resolveFlowDocumentSource(BIZ, "junk-ref", { client: db as unknown as Client })
    ).toMatchObject({ ok: false, error: "unsupported_ref" });
    expect(
      await resolveFlowDocumentSource(BIZ, "business-docs:not-a-uuid", {
        client: db as unknown as Client
      })
    ).toMatchObject({ ok: false, error: "unsupported_ref" });
    expect(
      await resolveFlowDocumentSource(BIZ, "email-attachments:inbound/msg1/0-photo.jpg", {
        client: db as unknown as Client
      })
    ).toMatchObject({ ok: false, error: "unsupported_type" });
  });

  it("fails CLOSED when the path is not on this tenant's mail and THROWS on a lookup fault", async () => {
    const notOwned = makeDb({ ownerRow: null });
    expect(
      await resolveFlowDocumentSource(BIZ, ATTACHMENT_REF, {
        client: notOwned.db as unknown as Client
      })
    ).toMatchObject({ ok: false, error: "not_found" });

    const lookupFault = makeDb({ ownerLookupError: { message: "db hiccup" } });
    await expect(
      resolveFlowDocumentSource(BIZ, ATTACHMENT_REF, {
        client: lookupFault.db as unknown as Client
      })
    ).rejects.toThrow("doc-source ownership lookup: db hiccup");
  });

  it("reports storage failures, empty bytes, and oversize", async () => {
    const download404 = makeDb({ download: { data: null, error: { message: "gone" } } });
    expect(
      await resolveFlowDocumentSource(BIZ, ATTACHMENT_REF, {
        client: download404.db as unknown as Client
      })
    ).toMatchObject({ ok: false, error: "not_found", detail: "gone" });

    const noData = makeDb({ download: { data: null, error: null } });
    expect(
      await resolveFlowDocumentSource(BIZ, ATTACHMENT_REF, {
        client: noData.db as unknown as Client
      })
    ).toMatchObject({ ok: false, error: "not_found", detail: "document missing from storage" });

    const emptyBlob = makeDb({ download: { data: new Blob([]), error: null } });
    expect(
      await resolveFlowDocumentSource(BIZ, ATTACHMENT_REF, {
        client: emptyBlob.db as unknown as Client
      })
    ).toMatchObject({ ok: false, error: "empty_document" });

    const big = makeDb();
    expect(
      await resolveFlowDocumentSource(BIZ, ATTACHMENT_REF, {
        client: big.db as unknown as Client,
        maxBytes: 3
      })
    ).toMatchObject({ ok: false, error: "too_large" });
  });
});
