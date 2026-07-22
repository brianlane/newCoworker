"use client";

import type { RefObject } from "react";

/**
 * Markdown formatting toolbar for the blog editor (bizblasts-style):
 * every button wraps the current selection or inserts a snippet at the
 * cursor, then restores focus/selection so typing continues naturally.
 * The stored format stays markdown — the toolbar is convenience, not a
 * separate rich-text pipeline.
 */

export type ToolbarLabels = {
  bold: string;
  italic: string;
  strikethrough: string;
  code: string;
  h1: string;
  h2: string;
  h3: string;
  link: string;
  image: string;
  quote: string;
  bulletList: string;
  numberedList: string;
  table: string;
};

const TABLE_TEMPLATE = [
  "| Column 1 | Column 2 |",
  "| --- | --- |",
  "| Cell | Cell |",
  "| Cell | Cell |"
].join("\n");

type ToolId = keyof ToolbarLabels;

/** Data-only descriptors; behavior lives in the component's dispatch. */
const TOOLBAR_BUTTONS: Array<{ id: ToolId; display: string }> = [
  { id: "bold", display: "B" },
  { id: "italic", display: "I" },
  { id: "strikethrough", display: "S̶" },
  { id: "code", display: "</>" },
  { id: "h1", display: "H1" },
  { id: "h2", display: "H2" },
  { id: "h3", display: "H3" },
  { id: "link", display: "🔗" },
  { id: "image", display: "🖼" },
  { id: "quote", display: "❝" },
  { id: "bulletList", display: "• List" },
  { id: "numberedList", display: "1. List" },
  { id: "table", display: "▦" }
];

/** Keep the textarea's selection when a toolbar button is pressed. */
function preventFocusSteal(event: React.MouseEvent): void {
  event.preventDefault();
}

export function BlogMarkdownToolbar({
  textareaRef,
  value,
  onChange,
  labels
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  labels: ToolbarLabels;
}) {
  const applyEdit = (next: string, selectionStart: number, selectionEnd: number) => {
    onChange(next);
    // Restore focus + selection after React re-renders the textarea.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(selectionStart, selectionEnd);
    });
  };

  /** Wrap the selection (or a placeholder) in before/after markers. */
  const wrap = (before: string, after: string, placeholder: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end) || placeholder;
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    applyEdit(next, start + before.length, start + before.length + selected.length);
  };

  /** Prefix every line the selection touches (headings, quotes, lists). */
  const prefixLines = (prefix: string | ((index: number) => string)) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEndIndex = value.indexOf("\n", end);
    const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
    const block = value.slice(lineStart, lineEnd);
    const prefixed = block
      .split("\n")
      .map((line, i) => (typeof prefix === "string" ? prefix : prefix(i)) + line)
      .join("\n");
    const next = value.slice(0, lineStart) + prefixed + value.slice(lineEnd);
    applyEdit(next, lineStart, lineStart + prefixed.length);
  };

  /** Insert a block snippet on its own lines at the cursor. */
  const insertBlock = (snippet: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const needsLeadingBreak = start > 0 && value[start - 1] !== "\n";
    const inserted = `${needsLeadingBreak ? "\n\n" : ""}${snippet}\n`;
    const next = value.slice(0, start) + inserted + value.slice(el.selectionEnd);
    const caret = start + inserted.length;
    applyEdit(next, caret, caret);
  };

  /** One dispatch point so the buttons array stays data-only. */
  const runTool = (id: ToolId) => {
    switch (id) {
      case "bold":
        return wrap("**", "**", "bold text");
      case "italic":
        return wrap("*", "*", "italic text");
      case "strikethrough":
        return wrap("~~", "~~", "struck text");
      case "code":
        return wrap("`", "`", "code");
      case "h1":
        return prefixLines("# ");
      case "h2":
        return prefixLines("## ");
      case "h3":
        return prefixLines("### ");
      case "link":
        return wrap("[", "](https://)", "link text");
      case "image":
        return wrap("![", "](https://)", "alt text");
      case "quote":
        return prefixLines("> ");
      case "bulletList":
        return prefixLines("- ");
      case "numberedList":
        return prefixLines((i) => `${i + 1}. `);
      case "table":
        return insertBlock(TABLE_TEMPLATE);
    }
  };

  return (
    <div className="flex flex-wrap gap-1 rounded-t-lg border border-b-0 border-parchment/15 bg-parchment/[0.03] p-1.5">
      {TOOLBAR_BUTTONS.map((b) => (
        <button
          key={b.id}
          type="button"
          title={labels[b.id]}
          aria-label={labels[b.id]}
          onMouseDown={preventFocusSteal}
          onClick={() => runTool(b.id)}
          className="rounded px-2.5 py-1 font-mono text-xs text-parchment/70 transition-colors hover:bg-parchment/10 hover:text-parchment"
        >
          {b.display}
        </button>
      ))}
    </div>
  );
}
