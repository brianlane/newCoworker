import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";

type LegalPageProps = {
  eyebrow: string;
  title: string;
  summary: string;
  effectiveDate: string;
  contactEmail: string;
  children: ReactNode;
};

export function LegalPage({
  eyebrow,
  title,
  summary,
  effectiveDate,
  contactEmail,
  children
}: LegalPageProps) {
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-3">
          <Image src="/logo.png" alt="New Coworker" width={36} height={36} className="rounded-full" />
          <span className="text-lg font-bold tracking-tight">New Coworker</span>
        </Link>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/privacy" className="text-parchment/60 transition-colors hover:text-parchment">
            Privacy
          </Link>
          <Link href="/terms" className="text-parchment/60 transition-colors hover:text-parchment">
            Terms
          </Link>
          <Link
            href="/onboard"
            className="rounded-lg bg-claw-green px-4 py-2 font-semibold text-deep-ink transition-colors hover:bg-opacity-90"
          >
            Get Started
          </Link>
        </div>
      </nav>

      <main className="mx-auto max-w-4xl px-6 pb-20 pt-8">
        <div className="rounded-3xl border border-parchment/10 bg-parchment/[0.03] p-8 sm:p-12">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-signal-teal">{eyebrow}</p>
          <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">{title}</h1>
          <p className="mt-5 max-w-3xl text-base leading-7 text-parchment/70 sm:text-lg">
            {summary}
          </p>
          <p className="mt-6 text-sm text-parchment/45">Effective date: {effectiveDate}</p>

          <div className="mt-10 space-y-8 text-sm leading-7 text-parchment/78 sm:text-base">
            {children}
          </div>
        </div>
      </main>

      <footer className="border-t border-parchment/10 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 text-xs text-parchment/35 sm:flex-row">
          <p>&copy; {new Date().getFullYear()} New Coworker. All rights reserved.</p>
          <div className="flex gap-6">
            <a href={`mailto:${contactEmail}`} className="transition-colors hover:text-parchment/60">Contact</a>
            <Link href="/privacy" className="transition-colors hover:text-parchment/60">Privacy Policy</Link>
            <Link href="/terms" className="transition-colors hover:text-parchment/60">Terms of Service</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

export function LegalSection({
  title,
  children
}: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold text-parchment">{title}</h2>
      <div className="space-y-3 text-parchment/72">
        {children}
      </div>
    </section>
  );
}
