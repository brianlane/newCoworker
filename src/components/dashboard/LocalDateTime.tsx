"use client";

/**
 * Render an ISO timestamp in the *browser's* local timezone.
 *
 * Why this exists:
 *   `Date#toLocaleString(undefined, …)` resolves "undefined" to the
 *   surrounding ICU locale + timezone. On a Vercel server-component
 *   render that's the runtime container's TZ (UTC), not the user's. The
 *   call-history list was rendering "May 5, 4:18 PM UTC" as if it were
 *   the customer's local time, which read as "the wrong time" in PT.
 *
 *   We render the SSR fallback (also using formatDateTime, which yields
 *   UTC on the server but at least has a consistent locale) wrapped in a
 *   <time dateTime={iso}> with `suppressHydrationWarning`, then re-render
 *   client-side after mount in the user's actual TZ. The hydration warning
 *   ("Server: …+00:00, Client: …Z") is expected and harmless — see the
 *   May 2026 retro for the trade-off vs server-side TZ detection.
 */

import { useEffect, useState } from "react";
import {
  formatDateTime,
  type FormatDateTimeStyle
} from "./voice-transcript-helpers";

export function LocalDateTime({
  iso,
  style = "list"
}: {
  iso: string;
  style?: FormatDateTimeStyle;
}) {
  const ssr = formatDateTime(iso, style);
  const [text, setText] = useState(ssr);

  useEffect(() => {
    setText(formatDateTime(iso, style));
  }, [iso, style]);

  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
