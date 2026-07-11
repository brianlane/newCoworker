/**
 * Upload ingestion + owner-edit rewrite (src/lib/documents/ingest.ts):
 * mime routing, the tolerant SUMMARY/--- reply parser, metering (including
 * billed-but-empty replies), and every failure classification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/ai-spend-meter", () => ({ meterGeminiSpendForBusiness: vi.fn() }));

import type { GeminiGenerateTextParams } from "@/lib/gemini-generate-content";
import {
  DOCUMENT_ALLOWED_MIME_TYPES,
  DOCUMENT_INGEST_MAX_TEXT_CHARS,
  ingestDocument,
  isSupportedDocumentMime,
  parseCondensedReply,
  rewriteDocumentContent
} from "@/lib/documents/ingest";
import { DOCUMENT_CONTENT_MD_MAX_CHARS, DOCUMENT_SUMMARY_MAX_CHARS } from "@/lib/documents/core";
import { GeminiEmptyError } from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";

const BIZ = "11111111-1111-4111-8111-111111111111";
const meter = vi.mocked(meterGeminiSpendForBusiness);

const ENV_KEYS = ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GEMINI_SUMMARY_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.GOOGLE_API_KEY = "test-key";
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_SUMMARY_MODEL;
  meter.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function generateOk(text: string) {
  return vi.fn(async (_params: GeminiGenerateTextParams) => ({
    text,
    usage: { promptTokens: 100, outputTokens: 50 }
  }));
}

const GOOD_REPLY = "SUMMARY: Prices for every service.\n---\n## Prices\n- Haircut: $40";

describe("isSupportedDocumentMime", () => {
  it("accepts exactly the allowed set", () => {
    for (const mime of DOCUMENT_ALLOWED_MIME_TYPES) {
      expect(isSupportedDocumentMime(mime)).toBe(true);
    }
    expect(isSupportedDocumentMime("application/msword")).toBe(false);
    expect(isSupportedDocumentMime("image/png")).toBe(false);
  });
});

describe("parseCondensedReply", () => {
  it("splits the SUMMARY/--- layout", () => {
    expect(parseCondensedReply(GOOD_REPLY)).toEqual({
      summary: "Prices for every service.",
      contentMd: "## Prices\n- Haircut: $40"
    });
  });

  it("collapses whitespace in the summary and caps both fields", () => {
    const reply = `SUMMARY: ${"a  b\n".repeat(200)}\n---\n${"x".repeat(20_000)}`;
    const parsed = parseCondensedReply(reply);
    expect(parsed.summary.length).toBeLessThanOrEqual(DOCUMENT_SUMMARY_MAX_CHARS);
    expect(parsed.summary).not.toMatch(/\n/);
    expect(parsed.contentMd.length).toBeLessThanOrEqual(DOCUMENT_CONTENT_MD_MAX_CHARS);
  });

  it("falls back to whole-reply content + first-line summary without the delimiter", () => {
    const parsed = parseCondensedReply("SUMMARY: only a summary line\nmore text");
    expect(parsed.contentMd).toBe("SUMMARY: only a summary line\nmore text");
    expect(parsed.summary).toBe("only a summary line");
  });
});

describe("ingestDocument (text)", () => {
  it("condenses text uploads and meters the spend", async () => {
    const generate = generateOk(GOOD_REPLY);
    const res = await ingestDocument(
      {
        businessId: BIZ,
        title: "Price sheet",
        mimeType: "text/plain",
        data: Buffer.from("Haircut $40. Beard trim $20. Open Mon-Fri."),
        businessName: "Clip Joint"
      },
      { generate }
    );
    expect(res).toEqual({
      ok: true,
      summary: "Prices for every service.",
      contentMd: "## Prices\n- Haircut: $40"
    });
    const call = generate.mock.calls[0][0];
    expect(call.userText).toContain('the business document "Price sheet" from Clip Joint');
    expect(call.userText).toContain("Haircut $40");
    expect(call.inlineParts).toBeUndefined();
    expect(meter).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, surface: "document_ingest" })
    );
  });

  it("strips NUL bytes and clips oversized text", async () => {
    const generate = generateOk(GOOD_REPLY);
    const res = await ingestDocument(
      {
        businessId: BIZ,
        title: "Big",
        mimeType: "text/markdown",
        data: Buffer.from("\u0000" + "z".repeat(DOCUMENT_INGEST_MAX_TEXT_CHARS + 500))
      },
      { generate }
    );
    expect(res.ok).toBe(true);
    const call = generate.mock.calls[0][0];
    expect(call.userText).not.toContain("\u0000");
  });

  it("rejects near-empty text without calling Gemini", async () => {
    const generate = generateOk(GOOD_REPLY);
    const res = await ingestDocument(
      { businessId: BIZ, title: "Empty", mimeType: "text/csv", data: Buffer.from("hi") },
      { generate }
    );
    expect(res).toEqual({ ok: false, error: "empty_content" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("maps an all-summary reply whose content is empty to empty_content", async () => {
    const generate = generateOk("SUMMARY: something\n---\n   ");
    const res = await ingestDocument(
      {
        businessId: BIZ,
        title: "Odd",
        mimeType: "text/plain",
        data: Buffer.from("Real content that is long enough to condense.")
      },
      { generate }
    );
    expect(res).toEqual({ ok: false, error: "empty_content" });
  });
});

describe("ingestDocument (pdf)", () => {
  it("sends the PDF as inlineData", async () => {
    const generate = generateOk(GOOD_REPLY);
    const res = await ingestDocument(
      {
        businessId: BIZ,
        title: "Menu",
        mimeType: "application/pdf",
        data: Buffer.from("%PDF-1.4 fake")
      },
      { generate }
    );
    expect(res.ok).toBe(true);
    const call = generate.mock.calls[0][0];
    expect(call.inlineParts).toEqual([
      {
        mimeType: "application/pdf",
        dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64")
      }
    ]);
    expect(call.userText).toContain("The document file is attached.");
  });

  it("rejects an empty PDF", async () => {
    const res = await ingestDocument(
      { businessId: BIZ, title: "Menu", mimeType: "application/pdf", data: Buffer.alloc(0) },
      { generate: generateOk(GOOD_REPLY) }
    );
    expect(res).toEqual({ ok: false, error: "empty_content" });
  });

  it("propagates a condense failure on the PDF path", async () => {
    delete process.env.GOOGLE_API_KEY;
    const res = await ingestDocument(
      { businessId: BIZ, title: "Menu", mimeType: "application/pdf", data: Buffer.from("%PDF") },
      { generate: generateOk(GOOD_REPLY) }
    );
    expect(res).toEqual({ ok: false, error: "summarizer_unavailable" });
  });

  it("maps a PDF reply with no content to empty_content", async () => {
    const res = await ingestDocument(
      {
        businessId: BIZ,
        title: "Menu",
        mimeType: "application/pdf",
        data: Buffer.from("%PDF")
      },
      { generate: generateOk("SUMMARY: only\n---\n ") }
    );
    expect(res).toEqual({ ok: false, error: "empty_content" });
  });
});

describe("ingestDocument (failure modes)", () => {
  const textInput = {
    businessId: BIZ,
    title: "Doc",
    mimeType: "text/plain",
    data: Buffer.from("Enough content to attempt condensing this document.")
  };

  it("rejects unsupported mime types", async () => {
    const res = await ingestDocument(
      { ...textInput, mimeType: "application/zip" },
      { generate: generateOk(GOOD_REPLY) }
    );
    expect(res).toEqual({ ok: false, error: "unsupported_type" });
  });

  it("reports summarizer_unavailable without an API key", async () => {
    delete process.env.GOOGLE_API_KEY;
    const res = await ingestDocument(textInput, { generate: generateOk(GOOD_REPLY) });
    expect(res).toEqual({ ok: false, error: "summarizer_unavailable" });
  });

  it("accepts GEMINI_API_KEY and a configured model", async () => {
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = "alt";
    process.env.GEMINI_SUMMARY_MODEL = "gemini-custom";
    const generate = generateOk(GOOD_REPLY);
    const res = await ingestDocument(textInput, { generate });
    expect(res.ok).toBe(true);
    expect(generate.mock.calls[0][0]).toMatchObject({ apiKey: "alt", model: "gemini-custom" });
  });

  it("classifies a thrown generate as summarizer_failed with detail", async () => {
    const generate = vi.fn(async () => {
      throw new Error("gemini_http_500: boom");
    });
    const res = await ingestDocument(textInput, { generate });
    expect(res).toEqual({
      ok: false,
      error: "summarizer_failed",
      detail: "gemini_http_500: boom"
    });
    expect(meter).not.toHaveBeenCalled();
  });

  it("meters a billed-but-empty reply before failing", async () => {
    const generate = vi.fn(async () => {
      throw new GeminiEmptyError({ promptTokens: 500, outputTokens: 100 });
    });
    const res = await ingestDocument(textInput, { generate });
    expect(res.ok).toBe(false);
    expect(meter).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "document_ingest",
        usage: { promptTokens: 500, outputTokens: 100 },
        outputChars: 0
      })
    );
  });

  it("tolerates non-Error throw values", async () => {
    const generate = vi.fn(async () => {
      throw "string failure";
    });
    const res = await ingestDocument(textInput, { generate });
    expect(res).toEqual({ ok: false, error: "summarizer_failed", detail: "string failure" });
  });
});

describe("rewriteDocumentContent", () => {
  it("applies the edit through the rewrite prompt", async () => {
    const generate = generateOk("SUMMARY: Updated prices.\n---\n- Haircut: $45");
    const res = await rewriteDocumentContent(
      {
        businessId: BIZ,
        title: "Price sheet",
        currentContentMd: "- Haircut: $40",
        instruction: "haircuts are now $45"
      },
      { generate }
    );
    expect(res).toEqual({ ok: true, summary: "Updated prices.", contentMd: "- Haircut: $45" });
    const call = generate.mock.calls[0][0];
    expect(call.userText).toContain("haircuts are now $45");
    expect(call.userText).toContain("- Haircut: $40");
    expect(call.systemInstruction).toContain("Apply the owner's requested edit");
    expect(meter).toHaveBeenCalledWith(expect.objectContaining({ surface: "document_update" }));
  });

  it("propagates condense failures", async () => {
    delete process.env.GOOGLE_API_KEY;
    const res = await rewriteDocumentContent(
      { businessId: BIZ, title: "T", currentContentMd: "c", instruction: "i" },
      { generate: generateOk("x") }
    );
    expect(res).toEqual({ ok: false, error: "summarizer_unavailable" });
  });
});
