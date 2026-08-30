import type { Metadata } from "next";
import Link from "next/link";
import { BookOpen, Code2, Smartphone } from "lucide-react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

/**
 * The docs index.
 *
 * This was a bare redirect to /docs/api while the API reference was the only
 * doc, with a note to become a real index once there was a second page. The
 * push guide is that second page, so the redirect is now the wrong shape: it
 * sent everyone who guessed at /docs to the developer reference, including the
 * owners looking for the phone setup.
 *
 * English only, matching both pages it lists.
 *
 * Add a doc here when you add one. Nothing enforces that, because a link list
 * has no compiler, but this page and sitemap.ts are the two places a new doc
 * has to reach to be findable at all.
 */

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Guides and reference for New Coworker: turning on push notifications, and the public REST API.",
  alternates: { canonical: "/docs" }
};

const DOCS = [
  {
    href: "/docs/push-notifications",
    Icon: Smartphone,
    eyebrow: "Guide",
    title: "Push notifications on your phone",
    body: "Install New Coworker on your iPhone, iPad, Android phone, or computer and get urgent alerts the moment they happen. Step by step, with screenshots."
  },
  {
    href: "/docs/api",
    Icon: Code2,
    eyebrow: "Reference",
    title: "API documentation",
    body: "The public REST API: send a text, start an AiFlow from an external event, read recent activity, and subscribe to webhooks with a business API key."
  }
] as const;

export default function DocsIndexPage() {
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />
      <main className="mx-auto max-w-4xl px-6 pb-24 pt-6">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-signal-teal">Docs</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">Documentation</h1>
        <p className="mt-5 text-base leading-7 text-parchment/70 sm:text-lg">
          Guides for getting the most out of your coworker, and the reference for wiring it into
          your own systems.
        </p>

        <div className="mt-12 grid gap-5 sm:grid-cols-2">
          {DOCS.map(({ href, Icon, eyebrow, title, body }) => (
            <Link
              key={href}
              href={href}
              className="group rounded-2xl border border-parchment/10 bg-parchment/[0.03] p-6 transition-colors hover:border-claw-green/40 hover:bg-parchment/[0.05]"
            >
              <Icon className="h-6 w-6 text-claw-green" aria-hidden />
              <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-parchment/45">
                {eyebrow}
              </p>
              <h2 className="mt-1 text-lg font-semibold text-parchment group-hover:text-claw-green">
                {title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-parchment/65">{body}</p>
            </Link>
          ))}
        </div>

        <div className="mt-14 flex items-start gap-4 rounded-2xl border border-parchment/10 bg-parchment/[0.03] p-6">
          <BookOpen className="mt-1 h-5 w-5 shrink-0 text-parchment/40" aria-hidden />
          <p className="text-sm text-parchment/70">
            Looking for something that is not here? The{" "}
            <Link href="/faq" className="text-claw-green hover:underline">
              FAQ
            </Link>{" "}
            covers the questions we are asked most, and you can reach a person from the{" "}
            <Link href="/contact" className="text-claw-green hover:underline">
              contact page
            </Link>
            .
          </p>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
