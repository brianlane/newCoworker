import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { TrackedCtaLink } from "./TrackedCtaLink";

/**
 * Shared section primitives for the public marketing pages, so every page
 * shares the same rhythm: hero → stat band → feature grids → CTA banner.
 * All server-renderable (no client JS).
 */

export function PageHero({
  eyebrow,
  title,
  subtitle,
  children,
  glow = false
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  /** Faint radial brand glow behind the hero (the homepage turns this on). */
  glow?: boolean;
}) {
  return (
    <section className="relative isolate mx-auto max-w-4xl px-6 pb-16 pt-16 text-center sm:pt-20">
      {glow && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-16 -z-10 h-[26rem] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(27,217,106,0.09),transparent_70%)]"
        />
      )}
      {eyebrow && (
        <p className="animate-fade-slide-up mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-signal-teal">{eyebrow}</p>
      )}
      <h1 className="animate-fade-slide-up stagger-1 font-display text-4xl font-bold leading-tight tracking-tight text-parchment text-balance sm:text-5xl">{title}</h1>
      {subtitle && (
        <p className="animate-fade-slide-up stagger-2 mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-parchment/60">{subtitle}</p>
      )}
      {children && <div className="animate-fade-slide-up stagger-3 mt-9">{children}</div>}
    </section>
  );
}

export type Stat = { value: string; label: string };

export function StatBand({ stats }: { stats: Stat[] }) {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-16">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-xl border border-parchment/10 bg-parchment/[0.03] px-5 py-6 text-center"
          >
            <p className="text-2xl font-bold text-claw-green sm:text-3xl">{s.value}</p>
            <p className="mt-2 text-xs leading-snug text-parchment/55 sm:text-sm">{s.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export type Feature = {
  title: string;
  description: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** When set, the whole card links there (a detail page or the docs). */
  href?: string;
};

export function FeatureCard({ feature }: { feature: Feature }) {
  const card = (
    <div className="marketing-reveal h-full rounded-xl border border-parchment/10 bg-parchment/[0.02] p-6 transition-[border-color,background-color,transform,box-shadow] duration-200 hover:border-signal-teal/40 hover:bg-parchment/[0.04] hover:shadow-[0_8px_30px_rgba(0,0,0,0.35)] motion-safe:hover:-translate-y-0.5">
      <div className="mb-2 flex items-center gap-2">
        <feature.Icon className="h-5 w-5 shrink-0 text-claw-green" />
        <h3 className="font-semibold text-parchment">{feature.title}</h3>
        {feature.href && (
          <ArrowUpRight aria-hidden className="ml-auto h-4 w-4 shrink-0 text-parchment/35" />
        )}
      </div>
      <p className="text-sm leading-relaxed text-parchment/50">{feature.description}</p>
    </div>
  );

  if (feature.href) {
    return (
      <Link
        href={feature.href}
        className="block h-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claw-green/60 focus-visible:ring-offset-2 focus-visible:ring-offset-deep-ink"
      >
        {card}
      </Link>
    );
  }
  return card;
}

export function FeatureGrid({
  features,
  columns = 3,
  centerLastRow = false
}: {
  features: Feature[];
  columns?: 2 | 3;
  /** Centers a short final row instead of stranding it bottom-left (the features page turns this on). */
  centerLastRow?: boolean;
}) {
  if (!centerLastRow) {
    const cols = columns === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2";
    return (
      <div className={`grid grid-cols-1 gap-6 ${cols}`}>
        {features.map((f) => (
          <FeatureCard key={f.title} feature={f} />
        ))}
      </div>
    );
  }

  // Half-width tracks (4 = two visual columns at sm, 6 = three at lg) so a
  // leftover card can start mid-grid; two tracks plus the inner gap equal one
  // plain-grid column, so card sizes match the un-centered variant exactly.
  const n = features.length;
  const cols = columns === 3 ? "sm:grid-cols-4 lg:grid-cols-6" : "sm:grid-cols-4";
  const lastCard = [
    n % 2 === 1 ? "sm:col-start-2" : "",
    columns === 3 && n % 3 === 1 ? "lg:col-start-3" : "",
    // The sm offset bleeds into lg (min-width media), so reset it when the lg
    // rows already divide evenly.
    columns === 3 && n % 3 !== 1 && n % 2 === 1 ? "lg:col-start-auto" : ""
  ]
    .filter(Boolean)
    .join(" ");
  const secondToLastCard = columns === 3 && n % 3 === 2 ? "lg:col-start-2" : "";
  const placement = (index: number) =>
    index === n - 1 ? lastCard : index === n - 2 ? secondToLastCard : "";

  return (
    <div className={`grid grid-cols-1 gap-6 ${cols}`}>
      {features.map((f, index) => (
        <div key={f.title} className={`sm:col-span-2 ${placement(index)}`.trim()}>
          <FeatureCard feature={f} />
        </div>
      ))}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  subtitle
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <div className="mb-10 text-center">
      {eyebrow && (
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-signal-teal">{eyebrow}</p>
      )}
      <h2 className="font-display text-2xl font-bold text-parchment text-balance sm:text-3xl">{title}</h2>
      {subtitle && (
        <p className="mx-auto mt-4 max-w-2xl text-parchment/55">{subtitle}</p>
      )}
    </div>
  );
}

export function CtaBanner({
  title,
  subtitle,
  ctaLabel = "Get Started",
  ctaHref = "/onboard"
}: {
  title: string;
  subtitle?: string;
  ctaLabel?: string;
  ctaHref?: string;
}) {
  return (
    <section className="mx-auto max-w-3xl px-6 pb-24 text-center">
      <div className="rounded-2xl border border-claw-green/20 bg-claw-green/5 p-10">
        <h2 className="mb-3 font-display text-2xl font-bold text-parchment">{title}</h2>
        {subtitle && <p className="mb-8 text-parchment/50">{subtitle}</p>}
        <TrackedCtaLink href={ctaHref} event="cta_get_started" eventProps={{ source: "banner" }}>
          {ctaLabel}
        </TrackedCtaLink>
      </div>
    </section>
  );
}

export type FaqItem = { question: string; answer: ReactNode };

/**
 * Server-rendered accordion via native details/summary, no client JS, and
 * the answers stay in the HTML for SEO.
 */
export function FaqAccordion({ items }: { items: FaqItem[] }) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <details
          key={item.question}
          className="group rounded-xl border border-parchment/10 bg-parchment/[0.02] open:border-signal-teal/30"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-parchment [&::-webkit-details-marker]:hidden">
            {item.question}
            <span aria-hidden className="text-parchment/40 transition-transform group-open:rotate-45">
              +
            </span>
          </summary>
          <div className="px-5 pb-5 text-sm leading-relaxed text-parchment/60">{item.answer}</div>
        </details>
      ))}
    </div>
  );
}
