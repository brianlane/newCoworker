import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The one marketing CTA. Filled calls-to-action on the public pages render
 * through this so the palette, radius, hover, and focus treatment cannot
 * drift per page. Before it existed every page carried its own copy of the
 * class string, still written as Tailwind v3's `hover:bg-opacity-90`, which
 * v4 removed, so filled CTAs shipped with no hover state at all.
 *
 * Deliberately not a client component: marketing pages are static, and the
 * few client callers (the nav) can import it from their own boundary.
 */

const VARIANT_CLASSES = {
  /** Filled claw-green: the primary action. */
  primary: "bg-claw-green text-deep-ink hover:bg-claw-green/90",
  /** Quiet outline: the secondary action beside a primary. */
  secondary: "border border-parchment/20 text-parchment hover:bg-parchment/10",
  /** Filled signal-teal: the highlighted plan's action. */
  accent: "bg-signal-teal text-deep-ink hover:bg-signal-teal/90"
} as const;

const SIZE_CLASSES = {
  md: "inline-block px-4 py-2 text-sm font-semibold",
  lg: "inline-block px-8 py-3.5 text-sm font-semibold",
  /** The one oversized CTA (the homepage call-the-demo number). */
  xl: "inline-flex items-center gap-3 px-8 py-3.5 text-lg font-bold"
} as const;

export type CtaLinkProps = {
  href: string;
  children: ReactNode;
  variant?: keyof typeof VARIANT_CLASSES;
  size?: keyof typeof SIZE_CLASSES;
  /** Render a plain anchor (tel:, mailto:, external) instead of next/link. */
  asAnchor?: boolean;
  /** Layout-only extras (display, widths, margins, alignment); never colors. */
  className?: string;
  /** Only meaningful when rendered from a client component (e.g. the nav). */
  onClick?: () => void;
};

export function CtaLink({
  href,
  children,
  variant = "primary",
  size = "lg",
  asAnchor = false,
  className,
  onClick
}: CtaLinkProps) {
  const classes = [
    "rounded-lg transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claw-green/60 focus-visible:ring-offset-2 focus-visible:ring-offset-deep-ink",
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    className
  ]
    .filter(Boolean)
    .join(" ");

  if (asAnchor) {
    return (
      <a href={href} className={classes} onClick={onClick}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={classes} onClick={onClick}>
      {children}
    </Link>
  );
}
