"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

/** False during SSR/hydration, true after — without an effect/setState pair. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

/**
 * Render a timestamp in the VIEWER's local time zone.
 *
 * Server components render timestamps in the server's zone (UTC in
 * production), which reads as "the time is wrong" to an owner in Phoenix.
 * This client component re-formats after hydration in the browser's zone.
 * Until hydrated it shows a compact UTC fallback (suppressHydrationWarning
 * covers the server/client divergence), so there is no layout jump — just the
 * text swapping to local time on mount.
 */
export function LocalTime({ iso, className }: { iso: string; className?: string }) {
  const hydrated = useHydrated();
  const date = new Date(iso);
  const text = hydrated
    ? date.toLocaleString()
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}
