import type { ReactNode } from "react";
import {
  CHAT_TEXT_WRAP_CLASS,
  chatImageFromLine,
  splitChatBlocks,
  tokenizeInlineMarkdown
} from "@/lib/chat-markdown";

export { chatImageFromLine, CHAT_TEXT_WRAP_CLASS } from "@/lib/chat-markdown";

/**
 * Minimal inline-markdown renderer: bold, italic, inline code, and http(s)
 * links (markdown and bare). Deliberate subset so assistant replies look
 * tidy without pulling in a full markdown library. Used by the onboarding
 * questionnaire chat and the owner `/dashboard/chat`.
 */
export function InlineMarkdown({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  for (const token of tokenizeInlineMarkdown(text)) {
    const key = `${parts.length}-${token.type}`;
    if (token.type === "strong") {
      parts.push(
        <strong key={key} className="font-semibold">
          {token.value}
        </strong>
      );
    } else if (token.type === "em") {
      parts.push(<em key={key}>{token.value}</em>);
    } else if (token.type === "code") {
      parts.push(
        <code key={key} className="rounded bg-parchment/10 px-1 py-0.5 text-[0.9em]">
          {token.value}
        </code>
      );
    } else if (token.type === "link") {
      parts.push(
        <a
          key={key}
          href={token.href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-claw-green underline underline-offset-2 hover:opacity-90"
        >
          {token.label}
        </a>
      );
    } else {
      parts.push(token.value);
    }
  }

  return <>{parts}</>;
}

function ChatImage({ alt, src }: { alt: string; src: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- proxy route, not a static asset
    <img
      src={src}
      alt={alt}
      className="max-h-96 max-w-full rounded-lg border border-parchment/10"
      loading="lazy"
    />
  );
}

/**
 * Paragraph / bullet list splitter. Treats a `-`/`•`/`*` run as a bullet
 * list even when a heading line sits above it in the same block, folds
 * wrapped continuation lines (bare URLs) into the previous item, renders
 * generated-image markdown lines as inline images, and otherwise wraps
 * each double-newline block in a `<p>`.
 */
export function ChatMarkdown({ text }: { text: string }) {
  const blocks = splitChatBlocks(text);

  return (
    <div className={`space-y-2 ${CHAT_TEXT_WRAP_CLASS}`}>
      {blocks.map((block, blockIdx) => {
        if (block.type === "image") {
          return <ChatImage key={blockIdx} alt={block.alt} src={block.src} />;
        }

        if (block.type === "list") {
          return (
            <ul key={blockIdx} className="list-disc space-y-0.5 pl-4">
              {block.items.map((item, i) => (
                <li key={i}>
                  {item.split("\n").map((line, j) => (
                    <span key={j}>
                      {j > 0 && <br />}
                      <InlineMarkdown text={line} />
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          );
        }

        return (
          <p key={blockIdx}>
            {block.lines.map((line, i) => {
              const lineImage = chatImageFromLine(line);
              return (
                <span key={i}>
                  {i > 0 && <br />}
                  {lineImage ? (
                    <ChatImage alt={lineImage.alt} src={lineImage.src} />
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
