import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  renderMarketingOg
} from "@/components/marketing/og-template";

export const runtime = "nodejs";

export const alt = "New Coworker vs GoHighLevel social preview";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// The bespoke page renders outside compare/[slug], so it needs its own card:
// a page that sets `openGraph` in generateMetadata replaces the whole object,
// which drops og images inherited from parent segments (config or file), and
// only a file in the page's own segment survives that. Copy mirrors
// marketing.compareGhl (ogTitle, heroTitle + heroHighlight).
export default function OpenGraphImage() {
  return renderMarketingOg({
    eyebrow: "Compare",
    title: "New Coworker vs GoHighLevel",
    subtitle: "One sells you software. We show up to work."
  });
}
