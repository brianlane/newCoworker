import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Briefcase, LifeBuoy, Mail, Users } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getAuthUser } from "@/lib/auth";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { ContactForm } from "@/components/marketing/ContactForm";
import { JsonLd } from "@/components/marketing/JsonLd";
import { PageHero } from "@/components/marketing/sections";

const CONTACT_PAGE_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "ContactPage",
  name: "Contact New Coworker",
  url: "https://newcoworker.com/contact",
  description:
    "Contact New Coworker for sales, support, white-glove onboarding, and partnerships. Most inquiries receive a response within 24 hours.",
  about: { "@id": "https://newcoworker.com/#organization" }
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.contactPage");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical: "/contact" },
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: "/contact"
    }
  };
}

const TOPIC_DEFS = [
  { key: "support", Icon: LifeBuoy },
  { key: "enterprise", Icon: Briefcase },
  { key: "whiteGlove", Icon: Users },
  { key: "everythingElse", Icon: Mail }
] as const;

/**
 * Known ?topic= values map to a prefilled form subject so CTAs elsewhere
 * (e.g. the white-glove lead button on /pricing and /dashboard/billing) land
 * as labeled leads. The message template gets the business name when the
 * visitor is a signed-in owner, so the lead arrives ready to send. Both
 * subject and message render in the visitor's locale (the form is editable
 * prefill — ops reads the lead in whichever language it arrives in).
 */
const TOPIC_DEFS_BY_PARAM: Record<
  string,
  { subjectKey: string; msgKey: string; msgForKey: string }
> = {
  "white-glove": {
    subjectKey: "subjectWhiteGlove",
    msgKey: "msgWhiteGlove",
    msgForKey: "msgWhiteGloveFor"
  },
  enterprise: {
    subjectKey: "subjectEnterprise",
    msgKey: "msgEnterprise",
    msgForKey: "msgEnterpriseFor"
  },
  support: { subjectKey: "subjectSupport", msgKey: "msgSupport", msgForKey: "msgSupportFor" }
};

/**
 * Prefill for signed-in visitors: their email, plus the active business's
 * owner name + business name. Best-effort — any failure (signed out, no
 * business, DB hiccup) just renders the empty public form.
 */
async function resolvePrefill(): Promise<{
  name?: string;
  email?: string;
  businessName?: string;
}> {
  try {
    const user = await getAuthUser();
    if (!user?.email) return {};
    const businessId = await resolveActiveBusinessId(user);
    if (!businessId) return { email: user.email };
    const db = await createSupabaseServiceClient();
    const { data } = await db
      .from("businesses")
      .select("name, owner_name, owner_email")
      .eq("id", businessId)
      .maybeSingle();
    const row = (data ?? null) as {
      name?: string | null;
      owner_name?: string | null;
      owner_email?: string | null;
    } | null;
    // Team members reach the business too — only claim the owner's name for
    // the "Name" field when the login actually is the owner.
    const isOwner =
      (row?.owner_email ?? "").trim().toLowerCase() === user.email.trim().toLowerCase();
    return {
      name: isOwner ? row?.owner_name?.trim() || undefined : undefined,
      email: user.email,
      businessName: row?.name?.trim() || undefined
    };
  } catch {
    return {};
  }
}

export default async function ContactPage({
  searchParams
}: {
  searchParams: Promise<{ topic?: string }>;
}) {
  const t = await getTranslations("marketing.contactPage");
  const { topic } = await searchParams;
  const topicDef = topic ? TOPIC_DEFS_BY_PARAM[topic] : undefined;
  const prefill = await resolvePrefill();
  const defaultSubject = topicDef ? t(topicDef.subjectKey) : undefined;
  const defaultMessage = topicDef
    ? prefill.businessName
      ? t(topicDef.msgForKey, { businessName: prefill.businessName })
      : t(topicDef.msgKey)
    : undefined;

  const topics = TOPIC_DEFS.map(({ key, Icon }) => ({
    title: t(`${key}.title`),
    description: t(`${key}.description`),
    Icon
  }));

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <JsonLd data={CONTACT_PAGE_JSON_LD} />
      <MarketingNav />

      <PageHero
        eyebrow={t("heroEyebrow")}
        title={t("heroTitle")}
        subtitle={t("heroSubtitle")}
      />

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="flex flex-col items-start gap-10 lg:flex-row">
          <div className="min-w-0 flex-1">
            <h2 className="text-3xl font-bold text-parchment">
              {t("formTitle")} <span className="text-claw-green">{t("formTitleHighlight")}</span>
            </h2>
            <p className="mt-4 leading-relaxed text-parchment/60">{t("formBody")}</p>

            <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2">
              {topics.map((topicCard) => (
                <div key={topicCard.title} className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-5">
                  <topicCard.Icon className="mb-3 h-5 w-5 text-claw-green" />
                  <h3 className="text-sm font-semibold text-parchment">{topicCard.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-parchment/50">{topicCard.description}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="w-full flex-shrink-0 lg:max-w-md">
            <ContactForm
              defaultSubject={defaultSubject}
              defaultName={prefill.name}
              defaultEmail={prefill.email}
              defaultBusinessName={prefill.businessName}
              defaultMessage={defaultMessage}
            />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-24 text-center">
        <p className="text-sm text-parchment/45">
          {t.rich("faqPrompt", {
            faq: (chunks: ReactNode) => (
              <Link href="/faq" className="text-signal-teal hover:underline">
                {chunks}
              </Link>
            ),
            pricing: (chunks: ReactNode) => (
              <Link href="/pricing" className="text-signal-teal hover:underline">
                {chunks}
              </Link>
            )
          })}
        </p>
      </section>

      <MarketingFooter />
    </div>
  );
}
