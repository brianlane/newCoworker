/**
 * Agent artifact → stored/downloaded bytes.
 *
 * One decision point shared by save-artifact and the run download route:
 * text targets pass through as-is (bytes: null → caller stores the artifact
 * text); binary targets render. Two PDF producers exist — the pure-JS
 * markdown typesetter (`pdf`/`docx` formats) and the VPS render sidecar
 * (`pdf_retypeset`, whose artifact is a self-contained HTML document) — and
 * the artifact's own shape picks between them: re-typeset artifacts are
 * always full HTML documents (ensureHtmlDocument in the run executor), and
 * markdown artifacts never are.
 */

import { typesetArtifact, typesetTargetKind } from "@/lib/documents/typeset";
import { renderHtmlToPdf } from "@/lib/documents/render-pdf";
import { isHtmlDocumentArtifact } from "./retypeset";

export type ArtifactBytesResult =
  | { ok: true; bytes: Buffer | null }
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
  const kind = typesetTargetKind(args.mimeType);
  if (!kind) return { ok: true, bytes: null };
  if (kind === "pdf" && isHtmlDocumentArtifact(args.artifactText)) {
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
    return { ok: true, bytes: rendered.pdf };
  }
  return { ok: true, bytes: await typesetArtifact(args.artifactText, args.mimeType) };
}
