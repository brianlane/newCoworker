import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeftRight,
  CalendarCheck,
  Code2,
  FileSpreadsheet,
  KeyRound,
  Mail,
  MessageSquareText,
  PhoneCall,
  Webhook,
  Zap
} from "lucide-react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import {
  CtaBanner,
  FeatureGrid,
  PageHero,
  SectionHeading,
  StatBand,
  type Feature
} from "@/components/marketing/sections";

export const metadata: Metadata = {
  title: "Integrations",
  description:
    "Connect New Coworker to Meta (Facebook & Instagram) lead ads, 8,000+ apps through Zapier, native Google Workspace and Microsoft 365 calendar & email, a public REST API, and webhooks.",
  alternates: { canonical: "/integrations" },
  openGraph: {
    title: "Integrations | New Coworker",
    description:
      "Meta lead ads, 8,000+ apps through Zapier, native Google & Microsoft calendar and email, public API, and webhooks.",
    url: "/integrations"
  }
};

const zapierTriggers = [
  { label: "SMS received", description: "A customer texts your business number", Icon: MessageSquareText },
  { label: "SMS sent", description: "Your coworker sends a customer a text", Icon: MessageSquareText },
  { label: "Call completed", description: "A call ends, with its AI summary attached", Icon: PhoneCall },
  { label: "Email activity", description: "Your coworker sends or receives email", Icon: Mail }
];

const nativeIntegrations: Feature[] = [
  {
    title: "Google Workspace",
    description:
      "Calendar slot-finding and booking plus email follow-ups through your Google account, connected in two clicks.",
    Icon: CalendarCheck
  },
  {
    title: "Microsoft 365",
    description:
      "The same calendar and email superpowers for Outlook and Microsoft 365 businesses.",
    Icon: CalendarCheck
  },
  {
    title: "Zapier",
    description:
      "One connection unlocks 8,000+ apps: CRMs, spreadsheets, Slack, help desks, invoicing. No code required.",
    Icon: Zap
  },
  {
    title: "Public REST API",
    description:
      "Per-business API keys let your systems send SMS, read events, and manage subscriptions programmatically.",
    Icon: Code2
  },
  {
    title: "Webhooks",
    description:
      "Real-time REST hooks push calls, texts, and email events to any endpoint the moment they happen.",
    Icon: Webhook
  },
  {
    title: "CSV Import & Export",
    description:
      "Bring your contacts in and take your data out whenever you want. Your records are never locked in.",
    Icon: FileSpreadsheet
  },
  {
    title: "Custom Integrations",
    description:
      "Point your coworker at your own internal tools and portals. It can browse and operate them like a person would.",
    Icon: ArrowLeftRight
  },
  {
    title: "Dashboard-Managed Keys",
    description:
      "Create, rotate, and revoke API keys from the integrations page. Hashed at rest, capped per business.",
    Icon: KeyRound
  }
];

export default function IntegrationsPage() {
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero
        eyebrow="Integrations"
        title={
          <>
            Connect your coworker to <span className="text-claw-green">8,000+ apps</span>
          </>
        }
        subtitle="Zapier, Google Workspace, Microsoft 365, and more: your coworker plugs into the tools your business already runs on. No code needed, and there's a developer API when you want it."
      />

      <StatBand
        stats={[
          { value: "Seconds", label: "From Meta ad lead submitted to lead texted back" },
          { value: "8,000+", label: "Apps reachable through one Zapier connection" },
          { value: "2 clicks", label: "To connect Google or Microsoft calendar & email" },
          { value: "REST", label: "Public API with per-business keys and webhooks" }
        ]}
      />

      {/* Meta lead capture */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow="Meta Lead Ads"
          title="Facebook & Instagram leads, answered while they're still looking at your ad"
          subtitle="Most businesses take hours to respond to an ad lead. Your coworker does it in seconds — automatically, every time, day or night."
        />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-claw-green">1 · Capture</p>
            <h3 className="mt-3 font-semibold text-parchment">A lead submits your Instant Form</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/50">
              Your Meta lead ads connect to your coworker through a simple bridge (a free Make.com
              account, Zapier, or lead tools like Privyr). A guided in-dashboard setup walks you
              through it in about 15 minutes — consent language included.
            </p>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-claw-green">2 · Act</p>
            <h3 className="mt-3 font-semibold text-parchment">Your coworker responds in seconds</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/50">
              The lead gets a personal text from your business number while their interest is
              hottest, and the two-way conversation is handled by the same coworker that answers
              your phone.
            </p>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-claw-green">3 · Follow through</p>
            <h3 className="mt-3 font-semibold text-parchment">Filed, routed, and remembered</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/50">
              Every lead is saved to your customer list with full context, offered to your team by
              text when you want routing, and you get a summary the moment it happens.
            </p>
          </div>
        </div>
        <div className="mt-6 rounded-xl border border-claw-green/20 bg-claw-green/[0.05] p-4 text-sm text-parchment/60">
          The same webhook trigger works for any lead source — Google lead forms, your website,
          TikTok, or anything that can send a webhook — not just Meta.
        </div>
      </section>

      {/* Zapier */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow="Zapier"
          title="If it's in Zapier, it works with New Coworker"
          subtitle="Wire your coworker's calls and texts into CRMs, spreadsheets, Slack, invoicing, and thousands of other apps. No code, no developer."
        />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <h3 className="font-semibold text-parchment">Triggers: when things happen here</h3>
            <p className="mt-1 text-sm text-parchment/50">
              Start any Zap from your coworker&apos;s activity.
            </p>
            <ul className="mt-5 space-y-4">
              {zapierTriggers.map((t) => (
                <li key={t.label} className="flex items-start gap-3">
                  <t.Icon className="mt-0.5 h-4 w-4 shrink-0 text-claw-green" />
                  <div>
                    <p className="text-sm font-semibold text-parchment">{t.label}</p>
                    <p className="text-sm text-parchment/50">{t.description}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <h3 className="font-semibold text-parchment">Actions: make things happen here</h3>
            <p className="mt-1 text-sm text-parchment/50">
              Let any app in your stack drive your coworker.
            </p>
            <ul className="mt-5 space-y-4">
              <li className="flex items-start gap-3">
                <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-signal-teal" />
                <div>
                  <p className="text-sm font-semibold text-parchment">Send SMS</p>
                  <p className="text-sm text-parchment/50">
                    Trigger a text from your business number when something happens anywhere else:
                    a new form fill, a paid invoice, a shipped order.
                  </p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <Zap className="mt-0.5 h-4 w-4 shrink-0 text-signal-teal" />
                <div>
                  <p className="text-sm font-semibold text-parchment">Send Lead to Coworker</p>
                  <p className="text-sm text-parchment/50">
                    Forward a lead from Facebook Lead Ads (or any trigger) and your coworker takes
                    over: instant text-back, filing, routing, and follow-up.
                  </p>
                </div>
              </li>
            </ul>
            <div className="mt-6 rounded-xl border border-signal-teal/20 bg-signal-teal/[0.05] p-4 text-sm text-parchment/60">
              Example: a new lead lands in your CRM → Zapier tells your coworker → the lead gets a
              personal text within seconds, and the reply is handled automatically.
            </div>
          </div>
        </div>
      </section>

      {/* Native + platform integrations */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow="Native & platform"
          title="Built-in connections, plus an API for everything else"
        />
        <FeatureGrid features={nativeIntegrations} columns={2} />
      </section>

      {/* Developer note */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-8 sm:p-10">
          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-signal-teal">
                For developers
              </p>
              <h2 className="text-2xl font-bold text-parchment">A real API, not a widget</h2>
              <p className="mt-4 leading-relaxed text-parchment/60">
                Your coworker comes with per-business API keys managed from your
                dashboard. Send messages, read call and message events (with AI summaries), and
                subscribe webhook endpoints to real-time events.
              </p>
              <Link
                href="/onboard"
                className="mt-6 inline-block rounded-lg border border-claw-green/40 px-6 py-2.5 text-sm font-semibold text-claw-green transition-colors hover:bg-claw-green/10"
              >
                Get API access
              </Link>
            </div>
            <pre className="mobile-scroll-x overflow-x-auto rounded-xl border border-parchment/10 bg-deep-ink p-5 text-xs leading-relaxed text-parchment/70">
{`POST /api/public/v1/messages
Authorization: Bearer nck_...

{
  "to": "+16025551234",
  "text": "Hi! Your appointment is confirmed
           for Tuesday at 2pm."
}`}
            </pre>
          </div>
        </div>
      </section>

      <CtaBanner
        title="Plug your coworker into your stack"
        subtitle="Zapier, calendar, email, and API access are built in. No connector fees."
        ctaLabel="Get Started"
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
