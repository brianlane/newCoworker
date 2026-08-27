import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  renderMarketingOg
} from "@/components/marketing/og-template";

export const runtime = "nodejs";

export const alt = "New Coworker blog social preview";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// Index card only: individual posts override it with their featured image
// via generateMetadata in blog/[slug]/page.tsx.
export default function OpenGraphImage() {
  return renderMarketingOg({
    eyebrow: "Blog",
    title: "The New Coworker blog",
    subtitle: "Announcements, tutorials, and practical tips."
  });
}
