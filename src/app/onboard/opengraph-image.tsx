import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  renderMarketingOg
} from "@/components/marketing/og-template";

export const runtime = "nodejs";

export const alt = "New Coworker onboard social preview"; // pragma: allowlist secret
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function OpenGraphImage() {
  return renderMarketingOg({
    eyebrow: "Get started",
    title: "Choose your plan",
    subtitle: "Calls, texts, emails, and more."
  });
}
