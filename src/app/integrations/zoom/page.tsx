import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  CalendarCheck,
  FileText,
  Link2,
  PlugZap,
  RefreshCcw,
  ShieldCheck,
  Trash2,
  Video
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { PageHero, SectionHeading } from "@/components/marketing/sections";

/**
 * Public documentation for the "New Coworker OAuth" Zoom Marketplace app:
 * how to add, use, and remove the integration. This page is the app's
 * Documentation URL in the Zoom Marketplace listing, so it must keep
 * covering add / use / remove end to end (a Zoom review requirement).
 * The canonical English URL renders English (default locale), so Zoom's
 * reviewers see the reviewed copy; the /es mirror renders Spanish.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.zoomPage");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical: "/integrations/zoom" },
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: "/integrations/zoom"
    }
  };
}

/** Scope identifiers are literal API values; only the use column localizes. */
const SCOPE_IDS = [
  "meeting:write:meeting",
  "meeting:update:meeting",
  "meeting:delete:meeting",
  "meeting:read:meeting / meeting:read:list_meetings",
  "meeting:write:invite_links",
  "user:read:user",
  "cloud_recording:read:meeting_transcript"
];

function StepCard({
  step,
  title,
  children
}: {
  step: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-claw-green">{step}</p>
      <h3 className="mt-3 font-semibold text-parchment">{title}</h3>
      <div className="mt-2 text-sm leading-relaxed text-parchment/50">{children}</div>
    </div>
  );
}

export default async function ZoomIntegrationDocsPage() {
  const t = await getTranslations("marketing.zoomPage");

  const bold = (chunks: ReactNode) => <b>{chunks}</b>;
  const italic = (chunks: ReactNode) => <i>{chunks}</i>;
  const zoomCardLink = (chunks: ReactNode) => (
    <Link href="/dashboard/integrations/zoom" className="text-claw-green hover:underline">
      {chunks}
    </Link>
  );

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

      {/* What it does */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading eyebrow={t("overviewEyebrow")} title={t("overviewTitle")} />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <Video className="h-5 w-5 text-claw-green" />
            <h3 className="mt-3 font-semibold text-parchment">{t("card1Title")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/50">{t("card1Body")}</p>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <Link2 className="h-5 w-5 text-claw-green" />
            <h3 className="mt-3 font-semibold text-parchment">{t("card2Title")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/50">{t("card2Body")}</p>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <RefreshCcw className="h-5 w-5 text-claw-green" />
            <h3 className="mt-3 font-semibold text-parchment">{t("card3Title")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/50">{t("card3Body")}</p>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7 lg:col-span-3">
            <FileText className="h-5 w-5 text-claw-green" />
            <h3 className="mt-3 font-semibold text-parchment">{t("card4Title")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/50">
              {t.rich("card4Body", { b: bold })}
            </p>
          </div>
        </div>
        <div className="mt-6 rounded-xl border border-claw-green/20 bg-claw-green/[0.05] p-4 text-sm text-parchment/60">
          <CalendarCheck className="mr-2 inline h-4 w-4 text-claw-green" />
          {t("prereqNote")}
        </div>
      </section>

      {/* How to add */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow={t("setupEyebrow")}
          title={t("setupTitle")}
          subtitle={t("setupSubtitle")}
        />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <StepCard step={t("step1Step")} title={t("step1Title")}>
            {t.rich("step1Body", { link: zoomCardLink })}
          </StepCard>
          <StepCard step={t("step2Step")} title={t("step2Title")}>
            {t.rich("step2Body", { b: bold })}
          </StepCard>
          <StepCard step={t("step3Step")} title={t("step3Title")}>
            {t("step3Body")}
          </StepCard>
        </div>
      </section>

      {/* How to use */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow={t("usageEyebrow")}
          title={t("usageTitle")}
          subtitle={t("usageSubtitle")}
        />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <h3 className="font-semibold text-parchment">{t("bookingTitle")}</h3>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-parchment/50">
              <li>{t("booking1")}</li>
              <li>{t("booking2")}</li>
              <li>{t("booking3")}</li>
            </ul>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <h3 className="font-semibold text-parchment">{t("changesTitle")}</h3>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-parchment/50">
              <li>{t.rich("changes1", { i: italic })}</li>
              <li>{t("changes2")}</li>
              <li>{t("changes3")}</li>
            </ul>
          </div>
        </div>
      </section>

      {/* How to remove */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow={t("removalEyebrow")}
          title={t("removalTitle")}
          subtitle={t("removalSubtitle")}
        />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <Trash2 className="h-5 w-5 text-signal-teal" />
            <h3 className="mt-3 font-semibold text-parchment">{t("removeDashTitle")}</h3>
            <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-parchment/50">
              <li>{t.rich("removeDash1", { link: zoomCardLink })}</li>
              <li>{t.rich("removeDash2", { b: bold })}</li>
              <li>{t("removeDash3")}</li>
            </ol>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <PlugZap className="h-5 w-5 text-signal-teal" />
            <h3 className="mt-3 font-semibold text-parchment">{t("removeZoomTitle")}</h3>
            <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-parchment/50">
              <li>
                {t.rich("removeZoom1", {
                  b: bold,
                  marketplace: (chunks: ReactNode) => (
                    <a
                      href="https://marketplace.zoom.us/user/installed"
                      className="text-claw-green hover:underline"
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {chunks}
                    </a>
                  )
                })}
              </li>
              <li>{t.rich("removeZoom2", { b: bold })}</li>
              <li>{t("removeZoom3")}</li>
            </ol>
          </div>
        </div>
      </section>

      {/* Scopes and data handling */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <SectionHeading
          eyebrow={t("scopesEyebrow")}
          title={t("scopesTitle")}
          subtitle={t("scopesSubtitle")}
        />
        <div className="overflow-x-auto rounded-2xl border border-parchment/10 bg-parchment/[0.02]">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-parchment/10 text-xs uppercase tracking-wider text-parchment/40">
                <th className="px-6 py-4">{t("scopeColHeader")}</th>
                <th className="px-6 py-4">{t("useColHeader")}</th>
              </tr>
            </thead>
            <tbody>
              {SCOPE_IDS.map((scope, index) => (
                <tr key={scope} className="border-b border-parchment/5 last:border-0">
                  <td className="px-6 py-3 font-mono text-xs text-claw-green">{scope}</td>
                  <td className="px-6 py-3 text-parchment/60">{t(`scopeUse${index + 1}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-6 rounded-xl border border-signal-teal/20 bg-signal-teal/[0.05] p-5 text-sm leading-relaxed text-parchment/60">
          <ShieldCheck className="mr-2 inline h-4 w-4 text-signal-teal" />
          {t.rich("privacyNote", {
            privacy: (chunks: ReactNode) => (
              <Link href="/privacy" className="text-claw-green hover:underline">
                {chunks}
              </Link>
            ),
            contact: (chunks: ReactNode) => (
              <Link href="/contact" className="text-claw-green hover:underline">
                {chunks}
              </Link>
            )
          })}
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
