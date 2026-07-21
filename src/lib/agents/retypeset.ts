/**
 * Re-typeset mode (`pdf_retypeset`) — layout-preserving PDF output.
 *
 * The model reads the source PDF/Word document natively and replies with ONE
 * self-contained styled-HTML document that visually mirrors the source's
 * design with the agent's instructions applied; the tenant's VPS render
 * sidecar (headless Chromium, POST /pdf) prints it to PDF at save/download
 * time. This module owns the HTML side: the artifact sanitizer (defense in
 * depth — the sidecar also disables JS and denies all network), the
 * document-shape guarantee renderers sniff on, and the text rendition used
 * for `content_md` so knowledge lookup still reads the filed copy.
 */

/** True when an artifact is a re-typeset HTML document (vs markdown). */
export function isHtmlDocumentArtifact(text: string): boolean {
  const head = text.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}

/**
 * Sanitize model-produced HTML: drop scripts/embeds/external references and
 * inline event handlers. `data:` URIs and `#` anchors survive; everything
 * else that could reach the network is removed. Belt-and-suspenders — the
 * sidecar renders with JavaScript disabled and every request aborted.
 */
export function sanitizeRetypesetHtml(html: string): string {
  let out = html;
  // Script/embed elements (paired first, then any stragglers).
  out = out.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  out = out.replace(/<(iframe|object|embed|frame)\b[\s\S]*?<\/\1\s*>/gi, "");
  out = out.replace(/<(script|iframe|object|embed|frame|frameset|link|base)\b[^>]*>/gi, "");
  // Inline event handlers (onclick=…), all three attribute quoting forms.
  out = out.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\son\w+\s*=\s*[^\s>]+/gi, "");
  // src/href attributes: keep data: URIs and same-document anchors only.
  out = out.replace(
    /\s(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (_m, attr: string, dq?: string, sq?: string, bare?: string) => {
      // Exactly one alternative matches, so one group is always a string.
      const value = ((dq ?? sq ?? bare) as string).trim();
      const lower = value.toLowerCase();
      if (lower.startsWith("data:") || value.startsWith("#")) return ` ${attr}="${value}"`;
      return "";
    }
  );
  // CSS escapes to the network via url(...) and @import.
  out = out.replace(/url\(\s*(['"]?)(?!\s*data:)[^)'"]*\1\s*\)/gi, "none");
  out = out.replace(/@import\b[^;]+;/gi, "");
  return out.trim();
}

/**
 * Guarantee the artifact is a full HTML document so downstream renderers can
 * sniff it deterministically: a fragment reply (the model skipped the shell)
 * gets wrapped; a full document passes through.
 */
export function ensureHtmlDocument(html: string): string {
  if (isHtmlDocumentArtifact(html)) return html;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>\n${html}\n</body></html>`;
}

/**
 * Plain-text rendition of an HTML artifact for `content_md` (knowledge
 * lookup reads text, not markup). Style/script bodies are dropped whole;
 * block-ish tags become line breaks so the text stays readable.
 */
export function htmlArtifactToText(html: string): string {
  return html
    .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(\/?)(p|div|br|h[1-6]|li|tr|table|section|article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
