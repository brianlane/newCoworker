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
 * Paragraph / bullet list splitter. Treats runs of `-`/`•`/`*` lines as a
 * bullet list, otherwise wraps each double-newline block in a `<p>`.
 */
export function ChatMarkdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);

  return (
    <div className="space-y-2">
      {blocks.map((block, blockIdx) => {
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
            {lines.map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                <InlineMarkdown text={line} />
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
