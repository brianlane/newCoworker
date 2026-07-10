import Image from "next/image";
import Link from "next/link";
import { SiteChatWidget } from "@/components/marketing/SiteChatWidget";

type FooterLink = { href: string; label: string; external?: boolean };

const PRODUCT_LINKS: FooterLink[] = [
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/integrations", label: "Integrations" },
  { href: "/industries", label: "Industries" },
  { href: "/compare/gohighlevel", label: "vs GoHighLevel" },
  { href: "/onboard", label: "Get Started" },
  { href: "/login", label: "Sign in" }
];

const COMPANY_LINKS: FooterLink[] = [
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
  { href: "/faq", label: "FAQ" }
];

const LEGAL_LINKS: FooterLink[] = [
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" }
];

function FooterColumn({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-parchment/40">{title}</p>
      <ul className="mt-3 space-y-2">
        {links.map((l) => (
          <li key={l.label}>
            {l.external ? (
              <a href={l.href} className="text-sm text-parchment/60 transition-colors hover:text-parchment">
                {l.label}
              </a>
            ) : (
              <Link href={l.href} className="text-sm text-parchment/60 transition-colors hover:text-parchment">
                {l.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-parchment/10">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-3">
              <Image src="/logo.png" alt="New Coworker" width={32} height={32} className="rounded-full" />
              <span className="font-bold tracking-tight text-parchment">New Coworker</span>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-parchment/45">
              Your AI employee that answers calls, texts, and emails around the clock, on infrastructure
              dedicated to your business.
            </p>
          </div>
          <FooterColumn title="Product" links={PRODUCT_LINKS} />
          <FooterColumn title="Company" links={COMPANY_LINKS} />
          <FooterColumn title="Legal" links={LEGAL_LINKS} />
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t border-parchment/10 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-parchment/30">
            &copy; {new Date().getFullYear()} New Coworker. All rights reserved.
          </p>
          <a
            href="/llms.txt"
            className="text-xs text-parchment/30 transition-colors hover:text-parchment/60"
          >
            For AI assistants
          </a>
        </div>
      </div>
      {/* Dogfooded website chat widget (bubble bottom-right on every marketing page). */}
      <SiteChatWidget />
    </footer>
  );
}
