import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  renderMarketingOg
} from "@/components/marketing/og-template";

export const runtime = "nodejs";

export const alt = "New Coworker features social preview";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function OpenGraphImage() {
  return renderMarketingOg({
    eyebrow: "Features",
    title: "Everything your AI coworker does",
    subtitle: "Calls, texts, email, booking, follow-up. 24/7."
  });
}
