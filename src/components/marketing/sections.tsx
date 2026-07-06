import Link from "next/link";
import type { ComponentType, ReactNode, SVGProps } from "react";

/**
 * Shared section primitives for the public marketing pages, so every page
 * shares the same rhythm: hero → stat band → feature grids → CTA banner.
 * All server-renderable (no client JS).
 */

export function PageHero({
  eyebrow,
  title,
  subtitle,
  children
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="mx-auto max-w-4xl px-6 pb-16 pt-16 text-center sm:pt-20">
      {eyebrow && (
        <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-signal-teal">{eyebrow}</p>
      )}
      <h1 className="text-4xl font-bold leading-tight tracking-tight text-parchment sm:text-5xl">{title}</h1>
      {subtitle && (
        <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-parchment/60">{subtitle}</p>
      )}
      {children && <div className="mt-9">{children}</div>}
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
};

export function FeatureCard({ feature }: { feature: Feature }) {
  return (
    <div className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-6 transition-colors hover:border-signal-teal/30">
      <div className="mb-2 flex items-center gap-2">
        <feature.Icon className="h-5 w-5 shrink-0 text-claw-green" />
        <h3 className="font-semibold text-parchment">{feature.title}</h3>
      </div>
      <p className="text-sm leading-relaxed text-parchment/50">{feature.description}</p>
    </div>
  );
}

export function FeatureGrid({ features, columns = 3 }: { features: Feature[]; columns?: 2 | 3 }) {
  const cols = columns === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2";
  return (
    <div className={`grid grid-cols-1 gap-6 ${cols}`}>
      {features.map((f) => (
        <FeatureCard key={f.title} feature={f} />
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
      <h2 className="text-2xl font-bold text-parchment sm:text-3xl">{title}</h2>
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
        <h2 className="mb-3 text-2xl font-bold text-parchment">{title}</h2>
        {subtitle && <p className="mb-8 text-parchment/50">{subtitle}</p>}
        <Link
          href={ctaHref}
          className="inline-block rounded-lg bg-claw-green px-8 py-3.5 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90"
        >
          {ctaLabel}
        </Link>
      </div>
    </section>
  );
}

export type FaqItem = { question: string; answer: ReactNode };

/**
 * Server-rendered accordion via native details/summary — no client JS, and
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
