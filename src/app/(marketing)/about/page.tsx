import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import {
  Brain,
  CalendarCheck,
  Lock,
  MessageSquareText,
  Phone,
  Server,
  Sparkles,
  Zap
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { JsonLd } from "@/components/marketing/JsonLd";
import {
  CtaBanner,
  FaqAccordion,
  FeatureGrid,
  PageHero,
  SectionHeading,
  type Feature
} from "@/components/marketing/sections";
import { esAlternatesForRequest } from "@/lib/i18n/es-metadata";
import { faqPageJsonLd } from "@/lib/marketing/faq-json-ld";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.about");
  const nav = await getTranslations("marketing.nav");
  const brand = nav("brand");
  const alternates = await esAlternatesForRequest("/about");
  return {
    title: t("metaTitle"),
    description: t("metaDescription", { brand }),
    alternates,
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription", { brand }),
      url: alternates.canonical
    }
  };
}

const CAPABILITY_DEFS = [
  { key: "contacts", Icon: Zap },
  { key: "answers", Icon: Phone },
  { key: "books", Icon: CalendarCheck },
  { key: "follows", Icon: MessageSquareText },
  { key: "remembers", Icon: Brain },
  { key: "dedicated", Icon: Server }
] as const;

const ICP_KEYS = ["icp1", "icp2", "icp3", "icp4"] as const;

const FACT_KEYS = [
  "product",
  "category",
  "does",
  "who",
  "sources",
  "channels",
  "runs",
  "data",
  "start"
] as const;

const FAQ_KEYS = ["faq1", "faq2", "faq3", "faq4", "faq5", "faq6"] as const;

const PRINCIPLE_DEFS = [
  { key: "privacy", Icon: Lock },
  { key: "employee", Icon: Sparkles },
  { key: "memory", Icon: Brain },
  { key: "stack", Icon: Server }
] as const;

export default async function AboutPage() {
  const t = await getTranslations("marketing.about");
  const nav = await getTranslations("marketing.nav");
  const brand = nav("brand");
  const line = (key: string) => t(key, { brand });

  const capabilities: Feature[] = CAPABILITY_DEFS.map(({ key, Icon }) => ({
    title: line(`${key}.title`),
    description: line(`${key}.description`),
    Icon
  }));

  const principles = PRINCIPLE_DEFS.map(({ key, Icon }) => ({
    title: line(`${key}.title`),
    description: line(`${key}.description`),
    Icon
  }));

  const faq = FAQ_KEYS.map((key) => {
    const question = line(`${key}.q`);
    const plainAnswer = line(`${key}.a`);
    return { question, plainAnswer, answer: <>{plainAnswer}</> };
  });

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <JsonLd data={faqPageJsonLd(faq)} />
      <MarketingNav />

      <PageHero
        eyebrow={line("heroEyebrow")}
        title={
          <>
            {line("heroTitle")} <span className="text-claw-green">{line("heroHighlight")}</span>
          </>
        }
        subtitle={line("heroSubtitle")}
      />

      <section className="mx-auto max-w-3xl px-6 pb-16 text-center">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-signal-teal">
          {line("valuePropEyebrow")}
        </p>
        <h2 className="font-display text-2xl font-bold text-parchment text-balance sm:text-3xl">
          {line("valuePropHeading")}
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-lg leading-relaxed text-parchment/80">
          {line("valueProp")}
        </p>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-20">
        <div className="space-y-5 leading-relaxed text-parchment/65">
          <p>{line("storyP1")}</p>
          <p>{line("storyP2")}</p>
          <p>{line("storyP3")}</p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow={line("doesEyebrow")}
          title={line("doesTitle")}
          subtitle={line("doesSubtitle")}
        />
        <FeatureGrid features={capabilities} />
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-20">
        <SectionHeading
          eyebrow={line("icpEyebrow")}
          title={line("icpTitle")}
          subtitle={line("icpSubtitle")}
        />
        <ul className="space-y-3">
          {ICP_KEYS.map((key) => (
            <li
              key={key}
              className="rounded-xl border border-parchment/10 bg-parchment/[0.02] px-5 py-4 text-sm leading-relaxed text-parchment/70"
            >
              {line(key)}
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-20">
        <SectionHeading eyebrow={line("factsEyebrow")} title={line("factsTitle")} />
        {/*
          Key facts stay a plain dl, with dt and dd as direct children, so a
          crawler can read each pair. Do not wrap the pairs in cards.
        */}
        <dl className="rounded-xl border border-parchment/10 bg-parchment/[0.02] px-5">
          {FACT_KEYS.map((key) => (
            <Fragment key={key}>
              <dt className="pt-4 text-xs font-semibold uppercase tracking-[0.16em] text-signal-teal">
                {line(`facts.${key}.term`)}
              </dt>
              <dd className="border-b border-parchment/10 pb-4 pt-1 text-sm leading-relaxed text-parchment/70 last:border-b-0">
                {line(`facts.${key}.detail`)}
              </dd>
            </Fragment>
          ))}
        </dl>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-20">
        <SectionHeading eyebrow={line("faqEyebrow")} title={line("faqTitle")} />
        <FaqAccordion items={faq} />
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading eyebrow={line("principlesEyebrow")} title={line("principlesTitle")} />
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {principles.map((p) => (
            <div key={p.title} className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-7">
              <p.Icon className="mb-4 h-6 w-6 text-claw-green" />
              <h3 className="font-semibold text-parchment">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-parchment/50">{p.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-24 text-center">
        <p className="text-parchment/55">
          {line("contactPrompt")}{" "}
          <Link href="/contact" className="text-signal-teal hover:underline">
            {line("contactLink")}
          </Link>
          .
        </p>
      </section>

      <CtaBanner
        title={line("ctaTitle")}
        subtitle={line("ctaSubtitle")}
        ctaLabel={line("ctaLabel")}
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
