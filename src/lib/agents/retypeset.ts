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

import sanitizeHtmlLib from "sanitize-html";

/** True when an artifact is a re-typeset HTML document (vs markdown). */
export function isHtmlDocumentArtifact(text: string): boolean {
  const head = text.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}

/**
 * Document-rendering tag vocabulary: sanitize-html's defaults plus the
 * shell/styling/media tags a typeset document legitimately needs. Scripts,
 * iframes, objects, forms, and link/base stay excluded.
 */
const RETYPESET_ALLOWED_TAGS = [
  ...sanitizeHtmlLib.defaults.allowedTags,
  "html",
  "head",
  "body",
  "title",
  "meta",
  "style",
  "img",
  "footer",
  "header"
];

/**
 * Sanitize model-produced HTML with a real HTML parser (sanitize-html —
 * never regex): scripts/embeds/event handlers are dropped, and src/href
 * survive only as `data:` URIs or same-document anchors, so nothing in the
 * document can reach the network. Belt-and-suspenders — the sidecar also
 * renders with JavaScript disabled and every request aborted. A CSS
 * post-pass neutralizes the stylesheet escape hatches (url(), @import).
 */
export function sanitizeRetypesetHtml(html: string): string {
  const sanitized = sanitizeHtmlLib(html, {
    allowedTags: RETYPESET_ALLOWED_TAGS,
    allowedAttributes: {
      "*": ["style", "class", "id", "colspan", "rowspan", "width", "height", "align", "valign"],
      img: ["src", "alt", "style", "class", "width", "height"],
      a: ["href", "name", "class", "style"],
      meta: ["charset"]
    },
    // `data:` is the only scheme that can carry bytes without the network;
    // relative refs (`#section`) are allowed by default and harmless.
    allowedSchemes: ["data"],
    allowProtocolRelative: false,
    parser: { lowerCaseAttributeNames: true }
  });
  // CSS escapes to the network via url(...) and @import (inside <style> or
  // style="" attributes, which the sanitizer deliberately keeps).
  return sanitized
    .replace(/url\(\s*(['"]?)(?!\s*data:)[^)'"]*\1\s*\)/gi, "none")
    .replace(/@import\b[^;]+;/gi, "")
    .trim();
}

/**
 * Guarantee the artifact is a full HTML document so downstream renderers can
 * sniff it deterministically: a fragment reply (the model skipped the shell)
 * gets wrapped; a full document passes through.
 */
export function ensureHtmlDocument(html: string): string {
  const head = html.trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith("<!doctype")) return html;
  // The sanitizer drops the doctype but keeps the <html> shell — restore it
  // so Chromium prints in standards mode and renderers sniff reliably.
  if (head.startsWith("<html")) return `<!DOCTYPE html>\n${html}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>\n${html}\n</body></html>`;
}

/**
 * Plain-text rendition of an HTML artifact for `content_md` (knowledge
 * lookup reads text, not markup). Parsed with sanitize-html (never regex):
 * style/script bodies are dropped whole and block-ish tags become line
 * breaks so the text stays readable. Entities decode in one ordered pass
 * (`&amp;` LAST, so a literal `&amp;lt;` can never double-unescape).
 */
export function htmlArtifactToText(html: string): string {
  // Every block-ish tag becomes <br> in the parser pass, so the only markup
  // left in the output is the literal void tag we swap for a newline — no
  // regex ever touches raw HTML.
  const blockTags = ["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "table"];
  const withBreaks = sanitizeHtmlLib(html, {
    allowedTags: ["br"],
    allowedAttributes: {},
    transformTags: Object.fromEntries(blockTags.map((tag) => [tag, "br"])),
    // Drop the CONTENTS of non-visible elements, not just their tags.
    nonTextTags: ["style", "script", "textarea", "option", "noscript"]
  });
  return withBreaks
    .replaceAll("<br />", "\n")
    // sanitize-html decodes &nbsp; to the literal U+00A0 character.
    .replaceAll("\u00a0", " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
