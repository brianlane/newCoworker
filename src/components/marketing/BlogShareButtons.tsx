"use client";

import { useState } from "react";

/** Share row on a blog post: X / LinkedIn intents + copy-to-clipboard. */
export function BlogShareButtons({
  url,
  title,
  labels
}: {
  url: string;
  title: string;
  labels: { x: string; linkedin: string; copy: string; copied: string };
}) {
  const [copied, setCopied] = useState(false);
  const encodedUrl = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(title);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions/http) — leave the label unchanged.
    }
  };

  const buttonClass =
    "rounded-lg border border-parchment/15 px-4 py-2 text-sm text-parchment/70 transition-colors hover:bg-parchment/5";

  return (
    <div className="flex flex-wrap gap-3">
      <a
        href={`https://twitter.com/intent/tweet?text=${encodedTitle}&url=${encodedUrl}`}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonClass}
      >
        {labels.x}
      </a>
      <a
        href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonClass}
      >
        {labels.linkedin}
      </a>
      <button type="button" onClick={copyLink} className={buttonClass}>
        {copied ? labels.copied : labels.copy}
      </button>
    </div>
  );
}
