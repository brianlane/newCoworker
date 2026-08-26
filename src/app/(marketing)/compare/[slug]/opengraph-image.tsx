import en from "../../../../../messages/en.json";
import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  renderMarketingOg
} from "@/components/marketing/og-template";
import { getComparison } from "../data";

export const runtime = "nodejs";

export const alt = "New Coworker comparison social preview";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// The English catalog is read directly rather than through next-intl,
// matching src/app/llms-full.txt/route.ts: social cards are shared into
// crawler caches, not localized per reader, and the global card is
// English-only too. The copy itself is guaranteed by tests/compare-pages.
const COMPARE_COPY = en.marketing.compare as Record<
  string,
  | { name?: string; ogTitle?: string; heroTitle?: string; heroHighlight?: string }
  | undefined
>;

export default async function OpenGraphImage({
  params
}: {
  params: Promise<{ slug: string }>;
}) {
  const entry = getComparison((await params).slug);
  const copy = entry ? COMPARE_COPY[entry.i18nKey] : undefined;
  return renderMarketingOg({
    eyebrow: "Compare",
    // Falls back to the index card's copy for a slug outside the registry
    // (the page itself 404s there, so nothing links to this variant).
    title:
      copy?.ogTitle ??
      (copy?.name ? `New Coworker vs ${copy.name}` : "The alternatives, side by side"),
    subtitle:
      copy?.heroTitle && copy?.heroHighlight
        ? `${copy.heroTitle} ${copy.heroHighlight}`
        : "Sourced from their own published pricing."
  });
}
