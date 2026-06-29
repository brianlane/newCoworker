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
  useIsomorphicLayoutEffect(() => {
    if (!anchorBottom) return;
    const el = ref.current;
    if (!el) return;
    const pinToBottom = () => {
      el.scrollTop = el.scrollHeight;
    };
    // Open scrolled to the newest message (before paint, so no flash).
    pinToBottom();
    // Re-pin when the list grows (a new bubble after a send + router.refresh),
    // but only when the user is already near the bottom so reading history isn't
    // interrupted.
    const observer = new MutationObserver(() => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom < 120) pinToBottom();
    });
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [anchorBottom]);
  return (
    <div ref={ref} className={`${maxHeightClass} overflow-y-auto ${className}`.trim()}>
      {children}
    </div>
  );
}
