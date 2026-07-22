/**
 * Agent artifact → stored/downloaded bytes.
 *
 * One decision point shared by save-artifact and the run download route:
 * text targets pass through as-is (bytes: null → caller stores the artifact
 * text); binary targets render. The run row's `output_mime_type` is the
 * EXPLICIT renderer discriminator — `text/html` (RETYPESET_ARTIFACT_MIME)
 * is written only by pdf_retypeset runs and routes to the VPS render
 * sidecar, while `application/pdf`/DOCX artifacts are always markdown and
 * typeset with the pure-JS renderer. A markdown artifact that merely LOOKS
 * like HTML can therefore never be misrouted to the sidecar (and a Starter
 * tenant's pdf/docx agents never depend on one).
 */

import { PDF_MIME_TYPE, typesetArtifact, typesetTargetKind } from "@/lib/documents/typeset";
import { renderHtmlToPdf } from "@/lib/documents/render-pdf";
import { RETYPESET_ARTIFACT_MIME } from "./core";

export type ArtifactBytesResult =
  | {
      ok: true;
      /** Rendered bytes, or null for text targets (store the artifact text). */
      bytes: Buffer | null;
      /** The representation's mime (retypeset html artifacts become PDFs). */
      mimeType: string;
    }
  | { ok: false; detail: string };

/**
 * Render an artifact's binary representation. `bytes: null` means the
 * target is a text format (store the artifact text directly); `ok: false`
 * means a required renderer failed (re-typeset with no reachable sidecar) —
 * callers surface it rather than silently degrading.
 */
export async function renderAgentArtifactBytes(args: {
  businessId: string;
  artifactText: string;
  mimeType: string;
}): Promise<ArtifactBytesResult> {
  const mime = args.mimeType.trim().toLowerCase();
  if (mime === RETYPESET_ARTIFACT_MIME) {
    const rendered = await renderHtmlToPdf(args.businessId, args.artifactText);
    if (!rendered.ok) {
      return {
        ok: false,
        detail:
          rendered.error === "not_configured"
            ? "PDF re-typesetting is not configured on this platform"
            : `PDF rendering failed: ${rendered.detail ?? "sidecar unavailable"}`
      };
    }
    return { ok: true, bytes: rendered.pdf, mimeType: PDF_MIME_TYPE };
  }
  const kind = typesetTargetKind(mime);
  if (!kind) return { ok: true, bytes: null, mimeType: args.mimeType };
  return {
    ok: true,
    bytes: await typesetArtifact(args.artifactText, mime),
    mimeType: args.mimeType
  };
}
