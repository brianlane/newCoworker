import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  renderMarketingOg
} from "@/components/marketing/og-template";

export const runtime = "nodejs";

export const alt = "New Coworker integrations social preview";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function OpenGraphImage() {
  return renderMarketingOg({
    eyebrow: "Integrations",
    title: "Plugs into the tools you already run on",
    subtitle: "Meta, Zapier, Google, Microsoft 365, API, webhooks."
  });
}
