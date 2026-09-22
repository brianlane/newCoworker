import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SectionMessages } from "@/components/i18n/SectionMessages";
import { esAlternatesForRequest } from "@/lib/i18n/es-metadata";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.onboard");
  const alternates = await esAlternatesForRequest("/onboard");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    // Self-canonical, not /pricing: this is the signup surface (sitemap
    // priority 0.9). og:title and twitter:title are not templated by the
    // root layout, so they carry the brand themselves. `metaTitle` does not.
    // Route-level opengraph-image.tsx / twitter-image.tsx supply the cards;
    // setting openGraph here without a file would wipe the root og:image.
    alternates,
    openGraph: {
      title: t("ogTitle"),
      description: t("metaDescription"),
      url: alternates.canonical,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: t("ogTitle"),
      description: t("metaDescription"),
    },
  };
}

export default function OnboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Ships the onboarding flow's client translation subset (questionnaire,
  // plan cards, order summary, plus `auth` for the success page's password
  // setup). Mapping and guard test: src/i18n/client-messages.ts.
  return <SectionMessages section="onboard">{children}</SectionMessages>;
}
