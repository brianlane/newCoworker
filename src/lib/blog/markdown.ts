/**
 * Minimal, deterministic markdown → HTML renderer for blog posts.
 *
 * Secure by construction: ALL input is HTML-escaped before any markup is
 * emitted, so raw HTML in a post (including AI-drafted content) renders as
 * literal text instead of executing. Only http(s) link/image URLs survive;
 * anything else (javascript:, data:) renders as plain text.
 *
 * Supported syntax — the subset the blog actually needs:
 *   headings (# … ######), paragraphs, bold, italic, inline code,
 *   fenced code blocks, links, images, ordered/unordered lists,
 *   blockquotes, horizontal rules.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Inline markup on an ALREADY-ESCAPED line. */
function renderInline(escaped: string): string {
  let out = escaped;
  // Pull code spans out first so `**x**` inside backticks stays literal;
  // they are restored verbatim after emphasis runs.
  const codeSpans: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(code);
    return `\u0001${codeSpans.length - 1}\u0001`;
  });
  // Images before links (shared bracket syntax).
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt: string, url: string) =>
    isSafeUrl(url) ? `<img src="${url}" alt="${alt}" loading="lazy" />` : match
  );
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text: string, url: string) =>
    isSafeUrl(url)
      ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
      : match
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/\u0001(\d+)\u0001/g, (_match, index: string) =>
    `<code>${codeSpans[Number(index)]}</code>`
  );
  return out;
}

type ListState = { kind: "ul" | "ol"; items: string[] };

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: ListState | null = null;
  let quote: string[] = [];
  let codeBlock: string[] | null = null;
  let codeLang = "";

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((i) => `<li>${renderInline(i)}</li>`).join("");
      html.push(`<${list.kind}>${items}</${list.kind}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      html.push(`<blockquote><p>${renderInline(quote.join(" "))}</p></blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const rawLine of lines) {
    // Fenced code blocks swallow everything until the closing fence.
    const fence = rawLine.match(/^```(\S*)\s*$/);
    if (codeBlock !== null) {
      if (fence) {
        const cls = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : "";
        html.push(`<pre><code${cls}>${codeBlock.join("\n")}</code></pre>`);
        codeBlock = null;
        codeLang = "";
      } else {
        codeBlock.push(escapeHtml(rawLine));
      }
      continue;
    }
    if (fence) {
      flushAll();
      codeBlock = [];
      codeLang = fence[1];
      continue;
    }

    const line = escapeHtml(rawLine.trimEnd());
    const trimmed = line.trim();

    if (!trimmed) {
      flushAll();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushAll();
      html.push("<hr />");
      continue;
    }

    const quoted = trimmed.match(/^&gt;\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.*)$/);
    if (unordered) {
      flushParagraph();
      flushQuote();
      if (!list || list.kind !== "ul") {
        flushList();
        list = { kind: "ul", items: [] };
      }
      list.items.push(unordered[1]);
      continue;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      flushQuote();
      if (!list || list.kind !== "ol") {
        flushList();
        list = { kind: "ol", items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(trimmed);
  }

  // An unterminated fence still renders as a code block rather than
  // silently dropping content.
  if (codeBlock !== null) {
    const cls = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : "";
    html.push(`<pre><code${cls}>${codeBlock.join("\n")}</code></pre>`);
  }
  flushAll();

  return html.join("\n");
}

/**
 * Markdown stripped to plain text (meta descriptions, RSS summaries).
 * Collapses whitespace; keeps link/image alt text.
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
