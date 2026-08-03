import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

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
  return <>{children}</>;
}
