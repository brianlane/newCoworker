import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  renderMarketingOg
} from "@/components/marketing/og-template";

export const runtime = "nodejs";

export const alt = "New Coworker FAQ social preview";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function OpenGraphImage() {
  return renderMarketingOg({
    eyebrow: "FAQ",
    title: "Questions, answered",
    subtitle: "Setup, porting, privacy, billing, and support."
  });
}
