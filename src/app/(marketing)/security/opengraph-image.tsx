import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  renderMarketingOg
} from "@/components/marketing/og-template";

export const runtime = "nodejs";

export const alt = "Security New Coworker social preview"; // pragma: allowlist secret
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// A page-level `openGraph` object in generateMetadata replaces inherited
// images from the root layout. Only a file in this segment survives that,
// which is why /security needs its own card. Copy mirrors
// marketing.securityPage (heroEyebrow, heroTitle) plus a short subtitle.
export default function OpenGraphImage() {
  return renderMarketingOg({
    eyebrow: "Security",
    title: "Security a reviewer can verify",
    subtitle: "Isolation, encryption, and privacy as code."
  });
}
