import type { ReactNode } from "react";

/**
 * Minimal inline-markdown renderer: bold, italic, and inline code. Deliberate
 * subset so assistant replies look tidy without pulling in a full markdown
 * library. Used by the onboarding questionnaire chat and the owner
 * `/dashboard/chat`.
 */
export function InlineMarkdown({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(
        <strong key={match.index} className="font-semibold">
          {match[2]}
        </strong>
      );
    } else if (match[3]) {
      parts.push(<em key={match.index}>{match[3]}</em>);
    } else if (match[4]) {
      parts.push(
        <code
          key={match.index}
          className="rounded bg-parchment/10 px-1 py-0.5 text-[0.9em]"
        >
          {match[4]}
        </code>
      );
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}

/**
 * Markdown image, restricted to the owner-authenticated generated-image
 * proxy. Only same-origin `/api/dashboard/images/…` sources render as an
 * `<img>` — any other URL stays plain text, so the model can never embed an
 * arbitrary remote image (tracking pixels, mixed content) in owner chat.
 */
const IMAGE_MD_RE = /^!\[([^\]]*)\]\((\/api\/dashboard\/images\/[^\s)]+)\)$/;

export function chatImageFromLine(line: string): { alt: string; src: string } | null {
  const m = IMAGE_MD_RE.exec(line.trim());
  if (!m) return null;
  return { alt: m[1] || "Generated image", src: m[2] };
}

/**
 * Paragraph / bullet list splitter. Treats runs of `-`/`•`/`*` lines as a
 * bullet list, renders generated-image markdown lines as inline images, and
 * otherwise wraps each double-newline block in a `<p>`.
 */
export function ChatMarkdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);

  return (
    <div className="space-y-2">
      {blocks.map((block, blockIdx) => {
        const image = chatImageFromLine(block);
        if (image) {
          return (
            // eslint-disable-next-line @next/next/no-img-element -- proxy route, not a static asset
            <img
              key={blockIdx}
              src={image.src}
              alt={image.alt}
              className="max-h-96 max-w-full rounded-lg border border-parchment/10"
              loading="lazy"
            />
          );
        }

        const lines = block.split("\n");
        const isList = lines.every(
          (l) => /^[-•*]\s/.test(l.trim()) || !l.trim()
        );

        if (isList) {
          return (
            <ul key={blockIdx} className="list-disc pl-4 space-y-0.5">
              {lines.map((line, i) => {
                const content = line.trim().replace(/^[-•*]\s+/, "");
                return content ? (
                  <li key={i}>
                    <InlineMarkdown text={content} />
                  </li>
                ) : null;
              })}
            </ul>
          );
        }

        return (
          <p key={blockIdx}>
            {lines.map((line, i) => {
              // The model may keep the image on the same block as its text
              // (no blank line) — still render it inline.
              const lineImage = chatImageFromLine(line);
              return (
                <span key={i}>
                  {i > 0 && <br />}
                  {lineImage ? (
                    // eslint-disable-next-line @next/next/no-img-element -- proxy route, not a static asset
                    <img
                      src={lineImage.src}
                      alt={lineImage.alt}
                      className="max-h-96 max-w-full rounded-lg border border-parchment/10"
                      loading="lazy"
                    />
                  ) : (
                    <InlineMarkdown text={line} />
                  )}
                </span>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}
