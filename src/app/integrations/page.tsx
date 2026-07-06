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
    "Connect New Coworker to 8,000+ apps through Zapier, plus native Google Workspace and Microsoft 365 calendar & email, a public REST API, and webhooks.",
  alternates: { canonical: "/integrations" },
  openGraph: {
    title: "Integrations | New Coworker",
    description:
      "8,000+ apps through Zapier, native Google & Microsoft calendar and email, public API, and webhooks.",
    url: "/integrations"
  }
};

const zapierTriggers = [
  { label: "SMS received", description: "A customer texts your business number", Icon: MessageSquareText },
  { label: "SMS sent", description: "Your coworker sends a customer a text", Icon: MessageSquareText },
  { label: "Call completed", description: "A call ends — with its AI summary attached", Icon: PhoneCall },
  { label: "Email activity", description: "Your coworker sends or receives email", Icon: Mail }
];

const nativeIntegrations: Feature[] = [
  {
    title: "Google Workspace",
    description:
      "Calendar slot-finding and booking plus email follow-ups through your Google account — connected in two clicks.",
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
      "One connection unlocks 8,000+ apps: CRMs, spreadsheets, Slack, help desks, invoicing — no code required.",
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
      "Bring your contacts in and take your data out whenever you want — your records are never locked in.",
    Icon: FileSpreadsheet
  },
  {
    title: "Custom Integrations",
    description:
      "Point your coworker at your own internal tools and portals — it can browse and operate them like a person would.",
    Icon: ArrowLeftRight
  },
  {
    title: "Dashboard-Managed Keys",
    description:
      "Create, rotate, and revoke API keys from the integrations page — hashed at rest, capped per business.",
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
        subtitle="Zapier, Google Workspace, Microsoft 365, a public API, and webhooks — your coworker plugs into the tools your business already runs on."
      />

      <StatBand
        stats={[
          { value: "8,000+", label: "Apps reachable through one Zapier connection" },
          { value: "2 clicks", label: "To connect Google or Microsoft calendar & email" },
          { value: "4 triggers", label: "Calls, texts, and email events pushed in real time" },
          { value: "REST", label: "Public API with per-business keys and webhooks" }
        ]}
      />

      {/* Zapier */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow="Zapier"
          title="If it's in Zapier, it works with New Coworker"
          subtitle="Wire your coworker's calls and texts into CRMs, spreadsheets, Slack, invoicing, and thousands of other apps — no code, no developer."
        />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <h3 className="font-semibold text-parchment">Triggers — when things happen here</h3>
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
            <h3 className="font-semibold text-parchment">Actions — make things happen here</h3>
            <p className="mt-1 text-sm text-parchment/50">
              Let any app in your stack drive your coworker.
            </p>
            <ul className="mt-5 space-y-4">
              <li className="flex items-start gap-3">
                <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-signal-teal" />
                <div>
                  <p className="text-sm font-semibold text-parchment">Send SMS</p>
                  <p className="text-sm text-parchment/50">
                    Trigger a text from your business number when something happens anywhere else —
                    a new form fill, a paid invoice, a shipped order.
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
                Standard and Enterprise plans include per-business API keys managed from your
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
        subtitle="Zapier, calendar, email, and API access are included with Standard plans."
        ctaLabel="Get Started"
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
