import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  renderMarketingOg
} from "@/components/marketing/og-template";

export const runtime = "nodejs";

export const alt = "About New Coworker social preview";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function OpenGraphImage() {
  return renderMarketingOg({
    eyebrow: "About",
    title: "Privacy-first digital employees",
    subtitle: "Dedicated infrastructure for every business."
  });
}
