import type { Metadata } from "next";
import {
  AlarmClockCheck,
  BarChart3,
  Bell,
  BookOpenCheck,
  Brain,
  CalendarCheck,
  Globe,
  LayoutDashboard,
  Mail,
  MessageSquareText,
  MessagesSquare,
  Phone,
  PhoneForwarded,
  PhoneIncoming,
  Rocket,
  Server,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Users,
  Workflow,
  Zap
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import {
  CtaBanner,
  FeatureGrid,
  PageHero,
  SectionHeading,
  type Feature
} from "@/components/marketing/sections";
import { TIER_LIMITS } from "@/lib/plans/limits";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.featuresPage");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical: "/features" },
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: "/features"
    }
  };
}

type GroupDef = {
  key: "voice" | "messaging" | "intelligence" | "automation" | "platform";
  features: { key: string; Icon: Feature["Icon"] }[];
};

const GROUP_DEFS: GroupDef[] = [
  {
    key: "voice",
    features: [
      { key: "answering", Icon: Phone },
      { key: "concurrent", Icon: PhoneIncoming },
      { key: "transfers", Icon: PhoneForwarded },
      { key: "booking", Icon: CalendarCheck },
      { key: "qualification", Icon: Users },
      { key: "byon", Icon: Smartphone }
    ]
  },
  {
    key: "messaging",
    features: [
      { key: "sms", Icon: MessageSquareText },
      { key: "rcs", Icon: MessagesSquare },
      { key: "duringCalls", Icon: Zap },
      { key: "missedCall", Icon: PhoneForwarded },
      { key: "scheduled", Icon: AlarmClockCheck },
      { key: "email", Icon: Mail }
    ]
  },
  {
    key: "intelligence",
    features: [
      { key: "summaries", Icon: Sparkles },
      { key: "sentiment", Icon: Users },
      { key: "analytics", Icon: BarChart3 },
      { key: "alerts", Icon: Bell },
      { key: "memory", Icon: Brain },
      { key: "website", Icon: Globe }
    ]
  },
  {
    key: "automation",
    features: [
      { key: "metaLeads", Icon: Zap },
      { key: "aiflows", Icon: Workflow },
      { key: "outbound", Icon: Phone },
      { key: "browser", Icon: Globe },
      { key: "routing", Icon: Users },
      { key: "notifications", Icon: Bell }
    ]
  },
  {
    key: "platform",
    features: [
      { key: "server", Icon: Server },
      { key: "dashboard", Icon: LayoutDashboard },
      { key: "compliance", Icon: ShieldCheck },
      { key: "deploy", Icon: Rocket },
      { key: "training", Icon: BookOpenCheck },
      { key: "whiteGlove", Icon: Users }
    ]
  }
];

export default async function FeaturesPage() {
  const t = await getTranslations("marketing.featuresPage");
  const calls = TIER_LIMITS.standard.maxConcurrentCalls;

  const groups = GROUP_DEFS.map((group) => ({
    eyebrow: t(`${group.key}.eyebrow`),
    title: t(`${group.key}.title`),
    subtitle: t(`${group.key}.subtitle`),
    features: group.features.map(({ key, Icon }) => ({
      title: t(`${group.key}.${key}.title`, { calls }),
      description: t(`${group.key}.${key}.description`, { calls }),
      Icon
    }))
  }));

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

      {groups.map((group) => (
        <section key={group.eyebrow} className="mx-auto max-w-6xl px-6 pb-20">
          <SectionHeading eyebrow={group.eyebrow} title={group.title} subtitle={group.subtitle} />
          <FeatureGrid features={group.features} />
        </section>
      ))}

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
