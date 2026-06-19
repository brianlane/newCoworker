"use client";

import { useSyncExternalStore } from "react";
import {
  formatDateTime,
  type FormatDateTimeStyle
} from "./voice-transcript-helpers";

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
 * Client-rendered date/time string in the browser's local timezone.
 *
 * Why: `formatDateTime` calls `Date.prototype.toLocaleString(undefined, …)`,
 * which on the server (RSC + Vercel build) resolves to the server's
 * locale/timezone — UTC in production. That made 04:50 UTC print as
 * "Jun 19, 4:50 AM" on the dashboard even though the owner is in Phoenix
 * (where it should read "Jun 18, 9:50 PM"). Rendering on the client lets the
 * viewer's timezone win.
 *
 * We use a hydration flag (false during SSR + first client paint, true after)
 * via `useSyncExternalStore` rather than `useState(localValue) + useEffect`.
 * The old approach silently broke: `useState` seeded the LOCAL value during
 * hydration, so the effect's `setState(local)` was a no-op and React never
 * replaced the server's UTC DOM text. The false→true transition here always
 * forces the swap. The pre-hydration branch formats explicitly in UTC so the
 * server and first client render produce identical markup.
 */
export function LocalDateTime({
  iso,
  style = "list"
}: {
  iso: string;
  style?: FormatDateTimeStyle;
}) {
  const hydrated = useHydrated();
  const text = hydrated
    ? formatDateTime(iso, style)
    : formatDateTime(iso, style, "UTC");

  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
