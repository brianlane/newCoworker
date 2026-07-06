"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Menu, X } from "lucide-react";

export type NavLink = { href: string; label: string };

export const MARKETING_NAV_LINKS: NavLink[] = [
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/integrations", label: "Integrations" },
  { href: "/industries", label: "Industries" },
  { href: "/faq", label: "FAQ" },
  { href: "/about", label: "About" }
];

export function MarketingNav() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-parchment/10 bg-deep-ink/85 backdrop-blur-md">
      <nav className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-4">
        <Link href="/" className="flex items-center gap-3" onClick={() => setOpen(false)}>
          <Image src="/logo.png" alt="New Coworker" width={34} height={34} className="rounded-full" />
          <span className="text-lg font-bold tracking-tight text-parchment">New Coworker</span>
        </Link>

        {/* Desktop links */}
        <div className="hidden items-center gap-7 md:flex">
          {MARKETING_NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-parchment/65 transition-colors hover:text-parchment"
            >
              {l.label}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-4 md:flex">
          <Link href="/login" className="text-sm text-parchment/60 transition-colors hover:text-parchment">
            Sign in
          </Link>
          <Link
            href="/onboard"
            className="rounded-lg bg-claw-green px-4 py-2 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90"
          >
            Get Started
          </Link>
        </div>

        {/* Mobile trigger */}
        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg border border-parchment/15 p-2 text-parchment md:hidden"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </nav>

      {/* Mobile panel */}
      {open && (
        <div className="border-t border-parchment/10 px-6 pb-6 pt-3 md:hidden">
          <div className="flex flex-col gap-1">
            {MARKETING_NAV_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-parchment/75 transition-colors hover:bg-parchment/5 hover:text-parchment"
              >
                {l.label}
              </Link>
            ))}
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-2.5 text-sm font-medium text-parchment/75 transition-colors hover:bg-parchment/5 hover:text-parchment"
            >
              Sign in
            </Link>
            <Link
              href="/onboard"
              onClick={() => setOpen(false)}
              className="mt-2 rounded-lg bg-claw-green px-4 py-2.5 text-center text-sm font-semibold text-deep-ink"
            >
              Get Started
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
