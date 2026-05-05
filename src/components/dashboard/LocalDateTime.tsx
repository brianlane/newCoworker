"use client";

import { useEffect, useState } from "react";
import {
  formatDateTime,
  type FormatDateTimeStyle
} from "./voice-transcript-helpers";

/**
 * Client-rendered date/time string in the browser's local timezone.
 *
 * Why: `formatDateTime` calls `Date.prototype.toLocaleString(undefined, …)`,
 * which on the server (RSC + Vercel build) resolves to the server's
 * locale/timezone — typically `en-US` / `UTC`. That made 16:18 UTC print as
 * "4:18 PM" on the dashboard even though the owner is in Pacific time
 * (where it should read "9:18 AM"). Rendering the formatted string on
 * the client guarantees the user's local timezone wins. We render the SSR
 * value first (so the markup is non-empty + hydration matches) and then
 * swap to the client-localized value after mount.
 */
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
