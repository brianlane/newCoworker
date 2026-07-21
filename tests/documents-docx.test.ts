import { describe, expect, it } from "vitest";
import { Document, Packer, Paragraph, TextRun } from "docx";
import {
  DOCX_MIME_TYPE,
  decodeDocxAttachment,
  decodeDocxToText,
  isDocxUpload
} from "@/lib/documents/docx";

/** Real .docx bytes built with the docx package (a valid Word zip). */
async function buildDocxFixture(paragraphs: string[]): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: paragraphs.map(
          (text) => new Paragraph({ children: [new TextRun({ text })] })
        )
      }
    ]
  });
  return Packer.toBuffer(doc);
}

describe("isDocxUpload", () => {
  it("accepts the canonical DOCX mime regardless of filename", () => {
    expect(isDocxUpload(DOCX_MIME_TYPE, "report.bin")).toBe(true);
  });

  it("accepts blank and octet-stream mimes under a .docx name", () => {
    expect(isDocxUpload("", "Quote.DOCX")).toBe(true);
    expect(isDocxUpload("application/octet-stream", "quote.docx ")).toBe(true);
  });

  it("rejects other mimes and non-.docx names", () => {
    expect(isDocxUpload("text/plain", "notes.docx")).toBe(false);
    expect(isDocxUpload("application/octet-stream", "notes.pdf")).toBe(false);
    expect(isDocxUpload("", "archive.docx.zip")).toBe(false);
  });
});

describe("decodeDocxToText", () => {
  it("extracts paragraph text from a real Word document", async () => {
    const bytes = await buildDocxFixture(["Premium: $1,200 per year", "Deductible: $500"]);
    const text = await decodeDocxToText(bytes);
    expect(text).toContain("Premium: $1,200 per year");
    expect(text).toContain("Deductible: $500");
  });

  it("returns null for bytes that are not a Word document", async () => {
    expect(await decodeDocxToText(Buffer.from("plain text, not a zip"))).toBeNull();
  });

  it("returns null for a Word document with no text", async () => {
    const bytes = await buildDocxFixture([]);
    expect(await decodeDocxToText(bytes)).toBeNull();
  });
});

describe("decodeDocxAttachment", () => {
  it("passes non-DOCX attachments through untouched", async () => {
    const attachment = {
      filename: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("hello")
    };
    expect(await decodeDocxAttachment(attachment)).toBe(attachment);
  });

  it("converts a DOCX attachment into a plain-text one", async () => {
    const bytes = await buildDocxFixture(["Renewal date: 2027-01-15"]);
    const converted = await decodeDocxAttachment({
      filename: "renewal.docx",
      mimeType: ` ${DOCX_MIME_TYPE.toUpperCase()} `,
      data: bytes
    });
    expect(converted).not.toBeNull();
    expect(converted!.filename).toBe("renewal.docx");
    expect(converted!.mimeType).toBe("text/plain");
    expect(converted!.data.toString("utf8")).toContain("Renewal date: 2027-01-15");
  });

  it("returns null for an unreadable DOCX attachment", async () => {
    const converted = await decodeDocxAttachment({
      filename: "broken.docx",
      mimeType: DOCX_MIME_TYPE,
      data: Buffer.from("corrupt")
    });
    expect(converted).toBeNull();
  });
});
