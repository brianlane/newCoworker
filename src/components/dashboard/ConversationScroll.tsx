"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

// useLayoutEffect runs before the browser paints, so the pane opens already at
// the bottom with no top-then-jump flash. Fall back to useEffect during SSR to
// avoid React's "useLayoutEffect does nothing on the server" warning.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Bounded, scrollable window for long conversation/message lists.
 *
 * Wraps a server-rendered list in a fixed-max-height `overflow-y-auto`
 * container so the surrounding page doesn't grow without bound and the newest
 * content (plus anything below it, like a composer) stays reachable without a
 * long page scroll.
 *
 * `anchorBottom` keeps the pane pinned to the newest content for oldest-first
 * conversations (SMS threads): it positions at the bottom before first paint,
 * and re-pins when the list grows (e.g. after a send triggers `router.refresh()`
 * and this wrapper re-renders with an extra bubble) — but only while the user is
 * already near the bottom, so scrolling up to read history is never yanked back.
 * Newest-first lists (e.g. the email inbox) leave it off so the top row stays in
 * view. We set `scrollTop` on the container itself rather than calling
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
  /** Keep the pane pinned to the bottom (oldest-first conversations). */
  anchorBottom?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether the user was at the bottom as of the last scroll, sampled from
  // scroll events so it reflects the position BEFORE any content growth. A
  // reflow doesn't move scrollTop, so measuring distance-from-bottom only after
  // the content grew would misread an at-bottom user as scrolled away once the
  // new content is taller than the threshold. Seeded true because we pin to the
  // bottom on mount.
  const nearBottomRef = useRef(true);
  useIsomorphicLayoutEffect(() => {
    if (!anchorBottom) return;
    const el = ref.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const THRESHOLD_PX = 120;
    const pinToBottom = () => {
      el.scrollTop = el.scrollHeight;
      nearBottomRef.current = true;
    };
    const onScroll = () => {
      nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // Open scrolled to the newest message (before paint, so no flash).
    pinToBottom();
    // Re-pin on ANY content reflow while the user was near the bottom: a new
    // bubble after a send + router.refresh, a client LocalDateTime label
    // swapping its text in after hydration, a late image/font load. A
    // ResizeObserver on the content wrapper catches height changes that a
    // MutationObserver(childList) would miss (e.g. text-only swaps).
    const observer = new ResizeObserver(() => {
      if (nearBottomRef.current) pinToBottom();
    });
    observer.observe(content);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [anchorBottom]);
  return (
    <div ref={ref} className={`${maxHeightClass} overflow-y-auto ${className}`.trim()}>
      <div ref={contentRef}>{children}</div>
    </div>
  );
}
