import en from "../../../../../messages/en.json";
import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  renderMarketingOg
} from "@/components/marketing/og-template";
import { getIndustry } from "../data";

export const runtime = "nodejs";

export const alt = "New Coworker industry social preview";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// The English catalog is read directly rather than through next-intl,
// matching src/app/llms-full.txt/route.ts: social cards are shared into
// crawler caches, not localized per reader, and the global card is
// English-only too.
const INDUSTRY_COPY = en.marketing.industries as Record<
  string,
  { name?: string } | undefined
>;

export default async function OpenGraphImage({
  params
}: {
  params: Promise<{ slug: string }>;
}) {
  const industry = getIndustry((await params).slug);
  const name = industry ? INDUSTRY_COPY[industry.i18nKey]?.name : undefined;
  return renderMarketingOg({
    eyebrow: "Industries",
    // Falls back to the index card's copy for a slug outside the registry
    // (the page itself 404s there, so nothing links to this variant).
    title: name ? `New Coworker for ${name}` : "Built for how your industry works",
    subtitle: "A 24/7 AI employee tuned to your industry."
  });
}
