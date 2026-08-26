import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  renderMarketingOg
} from "@/components/marketing/og-template";

// Force the Node runtime so build-time prerender stays self-contained.
// (The card renders from the inlined logo data URI, never a remote fetch:
// pointing satori at the very domain being deployed created a
// chicken-and-egg loop that hit the 60s export timeout. History and the
// shared visual system live in src/components/marketing/og-template.tsx.)
export const runtime = "nodejs";

export const alt = "New Coworker social preview";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function OpenGraphImage() {
  return renderMarketingOg({
    title: "Your AI employee that never sleeps",
    subtitle: "Calls. Texts. Emails. 24/7."
  });
}
