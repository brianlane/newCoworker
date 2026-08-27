"use client";

import { track } from "@vercel/analytics";
import { CtaLink, type CtaLinkProps } from "./CtaLink";

/**
 * CtaLink that reports the click to Vercel Web Analytics before navigating.
 *
 * A separate client leaf on purpose: the pages that render it stay static
 * server components, and only this button ships client JS. Events appear in
 * the Vercel project dashboard under Analytics, Events (custom events need
 * the paid Analytics tier; on the free tier `track` is a silent no-op, so
 * nothing breaks either way). The current page path is attached by Vercel
 * automatically, so props only carry what the path cannot tell us.
 */
export type TrackedCtaLinkProps = CtaLinkProps & {
  event: string;
  eventProps?: Record<string, string>;
};

export function TrackedCtaLink({ event, eventProps, onClick, ...rest }: TrackedCtaLinkProps) {
  return (
    <CtaLink
      {...rest}
      onClick={() => {
        track(event, eventProps);
        onClick?.();
      }}
    />
  );
}
