/**
 * Shared parsing for owner-facing chat markdown (companion panel,
 * /dashboard/chat, SMS transcripts, onboarding interview).
 *
 * Deliberate subset: bold, italic, inline code, http(s) markdown links,
 * bare URL autolinks, bullet lists, and the generated-image proxy. Long
 * unbreakable strings (Zoom URLs, calendar eids) overflow a flex bubble
 * unless the bubble can shrink AND wrap, so every chat surface uses
 * CHAT_TEXT_WRAP_CLASS (`min-w-0` for the flex min-width:auto trap,
 * `break-words` for overflow-wrap).
 */

import { trimTrailingUrlPunctuation } from "@/lib/booking-page/linkify-text";

/** Flex-shrink + overflow-wrap so a long URL cannot clip a chat bubble. */
export const CHAT_TEXT_WRAP_CLASS = "min-w-0 break-words";

type InlineToken =
  | { type: "text"; value: string }
  | { type: "strong"; value: string }
  | { type: "em"; value: string }
  | { type: "code"; value: string }
  | { type: "link"; href: string; label: string };

type ChatBlock =
  | { type: "image"; alt: string; src: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "list"; items: string[] };

const BULLET_RE = /^[-•*]\s+/;

/**
 * Markdown image, restricted to the owner-authenticated generated-image
 * proxy. Only a same-origin `/api/dashboard/images/<uuid>/<uuid>.<ext>`
 * source (the exact shape the generator writes) is accepted, any other
 * URL stays plain text, so the model can never embed an arbitrary remote
 * image (tracking pixels, mixed content) in owner chat. The src is
 * REBUILT from the strictly-charset-limited match groups (hex/dash uuids +
 * a whitelisted extension) rather than echoing matched text, so no
 * model-controlled bytes ever reach the attribute.
 */
const IMAGE_MD_RE =
  /^!\[([^\]]*)\]\(\/api\/dashboard\/images\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(png|jpg|jpeg|webp)\)$/i;

export function chatImageFromLine(line: string): { alt: string; src: string } | null {
  const m = IMAGE_MD_RE.exec(line.trim());
  if (!m) return null;
  return {
    alt: m[1] || "Generated image",
    src: `/api/dashboard/images/${m[2].toLowerCase()}/${m[3].toLowerCase()}.${m[4].toLowerCase()}`
  };
}

const INLINE_RE =
  /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>"']+))/g;

export function tokenizeInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((match = INLINE_RE.exec(text)) !== null) {
    const bangImage =
      Boolean(match[5] && match[6] && match.index > 0 && text[match.index - 1] === "!");
    const prefixEnd = bangImage ? match.index - 1 : match.index;
    if (prefixEnd > lastIndex) {
      tokens.push({ type: "text", value: text.slice(lastIndex, prefixEnd) });
    }
    if (bangImage) {
      tokens.push({
        type: "text",
        value: text.slice(prefixEnd, match.index + match[0].length)
      });
      lastIndex = match.index + match[0].length;
      continue;
    }
    if (match[2]) {
      tokens.push({ type: "strong", value: match[2] });
    } else if (match[3]) {
      tokens.push({ type: "em", value: match[3] });
    } else if (match[4]) {
      tokens.push({ type: "code", value: match[4] });
    } else if (match[5] && match[6]) {
      tokens.push({ type: "link", href: match[6], label: match[5] });
    } else {
      // Last alternative is a bare http(s) URL. Keep trailing punctuation
      // in the following text token, same rule as booking-page linkify, so
      // "see https://example.com." keeps the period.
      const href = trimTrailingUrlPunctuation(match[7] as string);
      tokens.push({ type: "link", href, label: href });
      lastIndex = match.index + href.length;
      INLINE_RE.lastIndex = lastIndex;
      continue;
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    tokens.push({ type: "text", value: text.slice(lastIndex) });
  }
  return tokens;
}

export function splitChatBlocks(text: string): ChatBlock[] {
  const out: ChatBlock[] = [];
  for (const raw of text.split(/\n{2,}/)) {
    const image = chatImageFromLine(raw);
    if (image) {
      out.push({ type: "image", ...image });
      continue;
    }
    out.push(...splitMixedBlock(raw));
  }
  return out;
}

function splitMixedBlock(block: string): ChatBlock[] {
  const lines = block.split("\n");
  const firstBullet = lines.findIndex((l) => BULLET_RE.test(l.trim()));
  if (firstBullet === -1) {
    return [{ type: "paragraph", lines }];
  }
  const blocks: ChatBlock[] = [];
  if (firstBullet > 0) {
    const leading = lines.slice(0, firstBullet);
    if (leading.some((l) => l.trim())) {
      blocks.push({ type: "paragraph", lines: leading });
    }
  }
  const items: string[] = [];
  for (const line of lines.slice(firstBullet)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (BULLET_RE.test(trimmed)) {
      items.push(trimmed.replace(BULLET_RE, ""));
    } else {
      items[items.length - 1] += `\n${trimmed}`;
    }
  }
  blocks.push({ type: "list", items });
  return blocks;
}
