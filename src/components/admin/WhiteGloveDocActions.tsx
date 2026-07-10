"use client";

/**
 * Action bar for the printable white-glove build document
 * (/admin/intake-doc/<id>): Print / Save as PDF (browser print), download the
 * markdown source, and copy it to the clipboard. Hidden in print media so the
 * document itself is all that lands on paper.
 */
import { useState } from "react";
import Link from "next/link";

export function WhiteGloveDocActions({
  markdown,
  filename
}: {
  markdown: string;
  filename: string;
}) {
  const [copied, setCopied] = useState(false);

  function download() {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions) — download still works.
    }
  }

  const buttonClass =
    "rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100";

  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
      <button type="button" className={buttonClass} onClick={() => window.print()}>
        Print / Save as PDF
      </button>
      <button type="button" className={buttonClass} onClick={download}>
        Download .md
      </button>
      <button type="button" className={buttonClass} onClick={copy}>
        {copied ? "Copied!" : "Copy text"}
      </button>
      <Link href="/admin/clients" className="ml-auto text-sm text-neutral-500 hover:underline">
        ← Back to admin
      </Link>
    </div>
  );
}
