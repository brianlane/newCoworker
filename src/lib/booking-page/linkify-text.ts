/**
 * Split owner-authored booking free text into plain segments and bare
 * http(s) URLs so the public page can render clickable anchors without
 * accepting HTML or markdown.
 *
 * Matches URLs after punctuation (e.g. paren wrappers) and peels trailing
 * sentence punctuation / unbalanced ")" so "(https://example.com/)" keeps
 * the closing paren outside the href.
 */

export type LinkifySegment =
  | { type: "text"; value: string }
  | { type: "url"; value: string };

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

function countChar(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** Peel trailing sentence punctuation without breaking balanced path parens. */
export function trimTrailingUrlPunctuation(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url[url.length - 1];
    if (!last) return url;
    if (".,;:!?".includes(last) || last === "]") {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ")" && countChar(url, ")") > countChar(url, "(")) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

export function linkifyText(text: string): LinkifySegment[] {
  if (!text) return [];
  const segments: LinkifySegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0];
    // matchAll always supplies index for a global regex.
    const index = match.index as number;
    const trimmed = trimTrailingUrlPunctuation(raw);
    if (index > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, index) });
    }
    segments.push({ type: "url", value: trimmed });
    cursor = index + trimmed.length;
  }
  if (cursor < text.length) {
    segments.push({ type: "text", value: text.slice(cursor) });
  }
  return segments;
}
