import { ImageResponse } from "next/og";
import { INLINE_LOGO_DATA_URI } from "@/app/inline-logo";

/**
 * Shared renderer for every marketing social card (opengraph-image.tsx /
 * twitter-image.tsx route files). One visual system, per-page copy: the
 * deep-ink radial gradient, the logo + wordmark header, an optional small
 * teal eyebrow, a large title, and a claw-green accent line.
 *
 * Satori constraints (this renders through next/og, not a browser):
 * - every element with more than one child needs an explicit `display: flex`,
 * - no custom font files; the default bundled font keeps the route light,
 * - the logo comes from INLINE_LOGO_DATA_URI rather than a URL, because the
 *   build-time prerender would otherwise fetch the very domain being
 *   deployed and hit the static export timeout (see src/app/inline-logo.ts
 *   and the history in src/app/opengraph-image.tsx).
 */

export const OG_SIZE = {
  width: 1200,
  height: 630
};

export const OG_CONTENT_TYPE = "image/png";

export type MarketingOgProps = {
  /** Small uppercase teal label above the title, e.g. "Pricing". */
  eyebrow?: string;
  title: string;
  /** Claw-green accent line under the title. Keep it to a few words. */
  subtitle?: string;
};

export function renderMarketingOg({ eyebrow, title, subtitle }: MarketingOgProps) {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background:
            "radial-gradient(circle at 70% 20%, #0e3a35 0%, #0b2238 45%, #07172d 100%)",
          color: "#f8f3ea",
          padding: "64px"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 30 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- satori markup rendered to a PNG, not a DOM element; next/image cannot run inside ImageResponse */}
          <img src={INLINE_LOGO_DATA_URI} width={72} height={72} alt="New Coworker logo" />
          <div style={{ fontSize: 40, fontWeight: 700 }}>New Coworker</div>
        </div>
        {eyebrow ? (
          <div
            style={{
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: 6,
              textTransform: "uppercase",
              color: "#2ec4b6",
              marginBottom: 18
            }}
          >
            {eyebrow}
          </div>
        ) : null}
        <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.1, maxWidth: "90%" }}>
          {title}
        </div>
        {subtitle ? (
          <div style={{ marginTop: 28, fontSize: 30, color: "#84f5bd" }}>{subtitle}</div>
        ) : null}
      </div>
    ),
    OG_SIZE
  );
}
