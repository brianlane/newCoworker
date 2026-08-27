"use client";

import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { CtaLink } from "@/components/marketing/CtaLink";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export type NavLink = { href: string; labelKey: string };

export const MARKETING_NAV_LINKS: NavLink[] = [
  { href: "/features", labelKey: "features" },
  { href: "/pricing", labelKey: "pricing" },
  { href: "/integrations", labelKey: "integrations" },
  { href: "/industries", labelKey: "industries" },
  { href: "/faq", labelKey: "faq" },
  { href: "/about", labelKey: "about" }
];

export function MarketingNav() {
  const t = useTranslations("marketing.nav");
  const [open, setOpen] = useState(false);
  const [authed, setAuthed] = useState(false);
  const headerRef = useRef<HTMLElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  // Session presence resolves after hydration (the Supabase client reads
  // browser cookies), so the anonymous CTAs render first and only a signed-in
  // visitor sees them swap to the Dashboard button. Marketing pages stay free
  // of server-side auth work on purpose (see src/proxy.ts).
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const supabase = getSupabaseBrowserClient();
        const {
          data: { session }
        } = await supabase.auth.getSession();
        if (active) setAuthed(Boolean(session));
      } catch {
        // Missing env or SDK failure: keep the anonymous CTAs.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Open-menu affordances: Escape closes (returning focus to the toggle),
  // a press outside the header closes, the page behind stops scrolling, and
  // crossing the md breakpoint closes too (the panel hides via md:hidden, so
  // without this a rotate/resize would strand the scroll lock with no visible
  // control to release it). All scoped to the open state so the closed nav
  // adds zero listeners.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (headerRef.current && e.target instanceof Node && !headerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const desktop = window.matchMedia("(min-width: 768px)");
    const onBreakpoint = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    desktop.addEventListener("change", onBreakpoint);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      desktop.removeEventListener("change", onBreakpoint);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-40 border-b border-parchment/10 bg-deep-ink/85 backdrop-blur-md"
    >
      <nav className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-4">
        <Link href="/" className="flex items-center gap-3" onClick={() => setOpen(false)}>
          <Image src="/logo.png" alt={t("brand")} width={34} height={34} className="rounded-full" />
          <span className="font-display text-lg font-bold tracking-tight text-parchment">{t("brand")}</span>
        </Link>

        <div className="hidden items-center gap-7 md:flex">
          {MARKETING_NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-parchment/65 transition-colors hover:text-parchment"
            >
              {t(l.labelKey)}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-4 md:flex">
          <LanguageSwitcher />
          {authed ? (
            <CtaLink href="/dashboard" size="md">
              {t("dashboard")}
            </CtaLink>
          ) : (
            <>
              <Link href="/login" className="text-sm text-parchment/60 transition-colors hover:text-parchment">
                {t("signIn")}
              </Link>
              <CtaLink href="/onboard" size="md">
                {t("getStarted")}
              </CtaLink>
            </>
          )}
        </div>

        <button
          ref={menuButtonRef}
          type="button"
          aria-label={open ? t("closeMenu") : t("openMenu")}
          aria-expanded={open}
          aria-controls="marketing-mobile-menu"
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg border border-parchment/15 p-2 text-parchment md:hidden"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </nav>

      {open && (
        <div id="marketing-mobile-menu" className="border-t border-parchment/10 px-6 pb-6 pt-3 md:hidden">
          <div className="mb-3">
            <LanguageSwitcher />
          </div>
          <div className="flex flex-col gap-1">
            {MARKETING_NAV_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-parchment/75 transition-colors hover:bg-parchment/5 hover:text-parchment"
              >
                {t(l.labelKey)}
              </Link>
            ))}
            {authed ? (
              <CtaLink
                href="/dashboard"
                size="md"
                className="mt-2 block text-center"
                onClick={() => setOpen(false)}
              >
                {t("dashboard")}
              </CtaLink>
            ) : (
              <>
                <Link
                  href="/login"
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-3 py-2.5 text-sm font-medium text-parchment/75 transition-colors hover:bg-parchment/5 hover:text-parchment"
                >
                  {t("signIn")}
                </Link>
                <CtaLink
                  href="/onboard"
                  size="md"
                  className="mt-2 block text-center"
                  onClick={() => setOpen(false)}
                >
                  {t("getStarted")}
                </CtaLink>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
