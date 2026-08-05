import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeftRight,
  Bot,
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
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import {
  CtaBanner,
  FeatureCard,
  PageHero,
  SectionHeading,
  StatBand
} from "@/components/marketing/sections";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.integrationsPage");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical: "/integrations" },
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: "/integrations"
    }
  };
}

const TRIGGER_DEFS = [
  { labelKey: "triggerSmsReceived", descKey: "triggerSmsReceivedDesc", Icon: MessageSquareText },
  { labelKey: "triggerSmsSent", descKey: "triggerSmsSentDesc", Icon: MessageSquareText },
  { labelKey: "triggerCallCompleted", descKey: "triggerCallCompletedDesc", Icon: PhoneCall },
  { labelKey: "triggerEmailActivity", descKey: "triggerEmailActivityDesc", Icon: Mail }
] as const;

const NATIVE_DEFS = [
  { key: "google", Icon: CalendarCheck },
  { key: "microsoft", Icon: CalendarCheck },
  { key: "zapier", Icon: Zap },
  { key: "api", Icon: Code2 },
  { key: "webhooks", Icon: Webhook },
  { key: "csv", Icon: FileSpreadsheet },
  { key: "custom", Icon: ArrowLeftRight },
  { key: "keys", Icon: KeyRound }
] as const;

export default async function IntegrationsPage() {
  const t = await getTranslations("marketing.integrationsPage");

  const zapierTriggers = TRIGGER_DEFS.map(({ labelKey, descKey, Icon }) => ({
    label: t(labelKey),
    description: t(descKey),
    Icon
  }));

  const nativeIntegrations = NATIVE_DEFS.map(({ key, Icon }) => ({
    title: t(`${key}.title`),
    description: t(`${key}.description`),
    Icon
  }));

  const claudeConnector = {
    title: t("claude.title"),
    description: t("claude.description"),
    Icon: Bot
  };

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero
        eyebrow={t("heroEyebrow")}
        title={
          <>
            {t("heroTitle")} <span className="text-claw-green">{t("heroHighlight")}</span>
          </>
        }
        subtitle={t("heroSubtitle")}
      />

      <StatBand
        stats={[
          { value: t("stat1Value"), label: t("stat1Label") },
          { value: t("stat2Value"), label: t("stat2Label") },
          { value: t("stat3Value"), label: t("stat3Label") },
          { value: t("stat4Value"), label: t("stat4Label") }
        ]}
      />

      {/* Meta lead capture */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow={t("metaEyebrow")}
          title={t("metaTitle2")}
          subtitle={t("metaSubtitle")}
        />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-claw-green">{t("captureStep")}</p>
            <h3 className="mt-3 font-semibold text-parchment">{t("captureTitle")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/50">{t("captureBody")}</p>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-claw-green">{t("actStep")}</p>
            <h3 className="mt-3 font-semibold text-parchment">{t("actTitle")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/50">{t("actBody")}</p>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-claw-green">{t("followStep")}</p>
            <h3 className="mt-3 font-semibold text-parchment">{t("followTitle")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/50">{t("followBody")}</p>
          </div>
        </div>
        <div className="mt-6 rounded-xl border border-claw-green/20 bg-claw-green/[0.05] p-4 text-sm text-parchment/60">
          {t("webhookNote")}
        </div>
      </section>

      {/* Zapier */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow={t("zapierEyebrow")}
          title={t("zapierTitle")}
          subtitle={t("zapierSubtitle")}
        />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <h3 className="font-semibold text-parchment">{t("triggersTitle")}</h3>
            <p className="mt-1 text-sm text-parchment/50">{t("triggersSubtitle")}</p>
            <ul className="mt-5 space-y-4">
              {zapierTriggers.map((trigger) => (
                <li key={trigger.label} className="flex items-start gap-3">
                  <trigger.Icon className="mt-0.5 h-4 w-4 shrink-0 text-claw-green" />
                  <div>
                    <p className="text-sm font-semibold text-parchment">{trigger.label}</p>
                    <p className="text-sm text-parchment/50">{trigger.description}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <h3 className="font-semibold text-parchment">{t("actionsTitle")}</h3>
            <p className="mt-1 text-sm text-parchment/50">{t("actionsSubtitle")}</p>
            <ul className="mt-5 space-y-4">
              <li className="flex items-start gap-3">
                <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-signal-teal" />
                <div>
                  <p className="text-sm font-semibold text-parchment">{t("actionSendSms")}</p>
                  <p className="text-sm text-parchment/50">{t("actionSendSmsDesc")}</p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <Zap className="mt-0.5 h-4 w-4 shrink-0 text-signal-teal" />
                <div>
                  <p className="text-sm font-semibold text-parchment">{t("actionSendLead")}</p>
                  <p className="text-sm text-parchment/50">{t("actionSendLeadDesc")}</p>
                </div>
              </li>
            </ul>
            <div className="mt-6 rounded-xl border border-signal-teal/20 bg-signal-teal/[0.05] p-4 text-sm text-parchment/60">
              {t("zapierExample")}
            </div>
          </div>
        </div>
      </section>

      {/* Native + platform integrations */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow={t("nativeEyebrow")}
          title={t("nativeTitle")}
        />
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          {nativeIntegrations.map((f) => (
            <FeatureCard key={f.title} feature={f} />
          ))}
          <div className="sm:col-span-2">
            <FeatureCard feature={claudeConnector} />
          </div>
        </div>
      </section>

      {/* Developer note */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-8 sm:p-10">
          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-signal-teal">
                {t("devEyebrow")}
              </p>
              <h2 className="text-2xl font-bold text-parchment">{t("devTitle")}</h2>
              <p className="mt-4 leading-relaxed text-parchment/60">{t("devBody")}</p>
              <Link
                href="/onboard"
                className="mt-6 inline-block rounded-lg border border-claw-green/40 px-6 py-2.5 text-sm font-semibold text-claw-green transition-colors hover:bg-claw-green/10"
              >
                {t("devCta")}
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
        title={t("ctaTitle")}
        subtitle={t("ctaSubtitle")}
        ctaLabel={t("ctaLabel")}
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
