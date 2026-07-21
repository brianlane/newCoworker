import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/render-pdf", () => ({
  renderHtmlToPdf: vi.fn()
}));

import { renderAgentArtifactBytes } from "@/lib/agents/artifact-bytes";
import { renderHtmlToPdf } from "@/lib/documents/render-pdf";

const BIZ = "11111111-1111-4111-8111-111111111111";
const HTML_DOC = "<!DOCTYPE html><html><body><h1>Re-typeset</h1></body></html>";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("renderAgentArtifactBytes", () => {
  it("passes text targets through with null bytes", async () => {
    const result = await renderAgentArtifactBytes({
      businessId: BIZ,
      artifactText: "# Markdown",
      mimeType: "text/markdown"
    });
    expect(result).toEqual({ ok: true, bytes: null, mimeType: "text/markdown" });
    expect(renderHtmlToPdf).not.toHaveBeenCalled();
  });

  it("typesets markdown artifacts for pdf and docx targets", async () => {
    const pdf = await renderAgentArtifactBytes({
      businessId: BIZ,
      artifactText: "# Title",
      mimeType: "application/pdf"
    });
    expect(pdf.ok && pdf.bytes!.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.ok && pdf.mimeType).toBe("application/pdf");

    const docx = await renderAgentArtifactBytes({
      businessId: BIZ,
      artifactText: "# Title",
      mimeType: DOCX_MIME
    });
    expect(docx.ok && docx.bytes!.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(docx.ok && docx.mimeType).toBe(DOCX_MIME);
    expect(renderHtmlToPdf).not.toHaveBeenCalled();
  });

  it("routes re-typeset artifacts (text/html mime) to the render sidecar as PDFs", async () => {
    const pdfBytes = Buffer.from("%PDF-1.7 sidecar");
    vi.mocked(renderHtmlToPdf).mockResolvedValue({ ok: true, pdf: pdfBytes });
    const result = await renderAgentArtifactBytes({
      businessId: BIZ,
      artifactText: HTML_DOC,
      mimeType: "text/html"
    });
    expect(result).toEqual({ ok: true, bytes: pdfBytes, mimeType: "application/pdf" });
    expect(renderHtmlToPdf).toHaveBeenCalledWith(BIZ, HTML_DOC);
  });

  it("never routes a pdf/docx-target artifact to the sidecar, even when it looks like HTML", async () => {
    // The MIME is the explicit discriminator: a pdf-format agent whose model
    // reply happens to be a full HTML document still typesets pure-JS (works
    // on Starter, no sidecar dependency).
    const result = await renderAgentArtifactBytes({
      businessId: BIZ,
      artifactText: HTML_DOC,
      mimeType: "application/pdf"
    });
    expect(result.ok && result.bytes!.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(renderHtmlToPdf).not.toHaveBeenCalled();
  });

  it("surfaces sidecar failures instead of degrading", async () => {
    vi.mocked(renderHtmlToPdf).mockResolvedValue({ ok: false, error: "not_configured" });
    const unconfigured = await renderAgentArtifactBytes({
      businessId: BIZ,
      artifactText: HTML_DOC,
      mimeType: "text/html"
    });
    expect(unconfigured).toEqual({
      ok: false,
      detail: "PDF re-typesetting is not configured on this platform"
    });

    vi.mocked(renderHtmlToPdf).mockResolvedValue({
      ok: false,
      error: "render_failed",
      detail: "sidecar http 502"
    });
    const failed = await renderAgentArtifactBytes({
      businessId: BIZ,
      artifactText: HTML_DOC,
      mimeType: "text/html"
    });
    expect(failed).toEqual({ ok: false, detail: "PDF rendering failed: sidecar http 502" });

    vi.mocked(renderHtmlToPdf).mockResolvedValue({ ok: false, error: "render_failed" });
    const noDetail = await renderAgentArtifactBytes({
      businessId: BIZ,
      artifactText: HTML_DOC,
      mimeType: "text/html"
    });
    expect(noDetail).toEqual({ ok: false, detail: "PDF rendering failed: sidecar unavailable" });
  });
});
