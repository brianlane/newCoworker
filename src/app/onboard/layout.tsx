import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SectionMessages } from "@/components/i18n/SectionMessages";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.onboard");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    // og:title and twitter:title are not templated by the root layout, so
    // they carry the brand themselves. `metaTitle` deliberately does not.
    openGraph: {
      title: t("ogTitle"),
      description: t("metaDescription"),
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
