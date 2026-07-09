/**
 * Collapse an HTML email body to readable plain text.
 *
 * Used as the fallback when a message has no usable text/plain part. A naive
 * "strip the tags" pass is NOT enough for marketing mail (Mailchimp etc.):
 * the contents of <style>/<script>/<title> and MSO conditional comments sit
 * BETWEEN tags, so tag-stripping alone leaks whole CSS sheets and unrendered
 * merge tags (e.g. `*|MC:SUBJECT|*` from <title>) into the "text" the
 * dashboard and flow triggers then see. Mirrors src/lib/ai-flows/trigger-eval
 * htmlToText, extended with comment/title/head removal for raw email HTML.
 *
 * Kept dependency-free (no postal-mime / workers-types imports) so the root
 * vitest suite can unit-test it directly.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\b[^>]*>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<title\b[^>]*>[\s\S]*?<\/title\b[^>]*>/gi, " ")
    // Keep link destinations: `<a href="U">label</a>` → `label (U)`. Without
    // this, tag-stripping silently discards every URL — e.g. an "Accept
    // invitation" button becomes dead text. http(s) only; tracking-pixel
    // anchors and `href="#"` noise stay dropped.
    .replace(
      /<a\b[^>]*\bhref\s*=\s*["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a\b[^>]*>/gi,
      (_m, href: string, label: string) => ` ${label} (${href}) `
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Decode &amp; LAST so "&amp;lt;" does not double-unescape into "<".
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a message's "plain text" part is really tag-stripped template
 * source rather than prose. Some senders (e.g. Privyr via Mailchimp
 * templates) generate the text/plain alternative by naively stripping tags
 * from the HTML, which leaves the whole stylesheet and unrendered merge tags
 * (`*|MC:SUBJECT|*`) in the "text". Signals:
 *  - a Mailchimp-style merge tag anywhere, or
 *  - several CSS rule blocks (`selector { prop:value; ... }`).
 * A false positive only means the text gets re-derived from the HTML part,
 * which is safe; a false negative just keeps today's behavior.
 */
export function looksLikeStrippedTemplate(text: string): boolean {
  if (/\*\|[^|*\s][^|*]*\|\*/.test(text)) return true;
  const cssBlocks = text.match(/\{[^{}]*:[^{}]*;[^{}]*\}/g);
  return (cssBlocks?.length ?? 0) >= 3;
}
