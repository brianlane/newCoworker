"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Bounded, scrollable window for long conversation/message lists.
 *
 * Wraps a server-rendered list in a fixed-max-height `overflow-y-auto`
 * container so the surrounding page doesn't grow without bound and the newest
 * content (plus anything below it, like a composer) stays reachable without a
 * long page scroll.
 *
 * `anchorBottom` scrolls the container to its bottom once on mount — use it for
 * oldest-first conversations (SMS threads) where the newest message sits at the
 * end. Newest-first lists (e.g. the email inbox) leave it off so the top row
 * stays in view. We set `scrollTop` on the container itself rather than calling
 * `scrollIntoView` on a sentinel so only this pane scrolls, never the window.
 */
export function ConversationScroll({
  children,
  maxHeightClass = "max-h-[60vh]",
  anchorBottom = false,
  className = ""
}: {
  children: ReactNode;
  /** Tailwind max-height class bounding the scroll window. */
  maxHeightClass?: string;
  /** Scroll to the bottom on mount (oldest-first conversations). */
  anchorBottom?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!anchorBottom) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [anchorBottom]);
  return (
    <div ref={ref} className={`${maxHeightClass} overflow-y-auto ${className}`.trim()}>
      {children}
    </div>
  );
}
