import type { MetadataRoute } from "next";

/**
 * The web app manifest, served at /manifest.webmanifest.
 *
 * A metadata route rather than a static file in public/, for three reasons:
 * it is typed, so a typo in `display` is a compile error instead of a silent
 * install failure; Next injects the <link rel="manifest"> itself, which
 * matters because src/app/layout.tsx deliberately has no <head>; and a file
 * under public/ would be served with the wildcard CORS header that
 * next.config.ts exists to override. src/app/sitemap.ts is the in-repo
 * precedent.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    /**
     * The install identity. NEVER change this string: browsers key an
     * installed app on it, so a new value creates a duplicate install for
     * everyone who already added the app, and silently orphans the old one.
     * It is intentionally separate from start_url, which is free to move.
     */
    id: "/dashboard",
    name: "New Coworker",
    /**
     * This is the label iOS prints under the Home Screen icon, and it is what
     * the Add to Home Screen sheet pre-fills. Safari prefers the manifest's
     * short_name over apple-mobile-web-app-title, so "Coworker" here showed up
     * as a Home Screen icon called "Coworker" and the brand name never
     * appeared on the device at all.
     *
     * Twelve characters still fits without an ellipsis at every Home Screen
     * icon size, so there is nothing to buy by shortening it.
     */
    short_name: "New Coworker",
    description: "Alerts from your AI coworker, on your home screen.",
    /**
     * `?source=pwa` makes launches from an installed app separable in
     * analytics. One start_url serves both audiences because src/proxy.ts
     * already redirects an admin hitting /dashboard to /admin/dashboard, so
     * there is no need for a second manifest.
     */
    start_url: "/dashboard?source=pwa",
    /**
     * The whole origin, NOT /dashboard.
     *
     * A launch with an expired session lands on /login. Under a /dashboard
     * scope that navigation leaves the scope, so the browser kicks it out of
     * the standalone window into a normal tab, and the owner is suddenly
     * looking at Safari instead of the app they tapped. Scope "/" also lets
     * this one registration serve /admin.
     */
    scope: "/",
    display: "standalone",
    background_color: "#0d2235",
    theme_color: "#0d2235",
    lang: "en",
    dir: "ltr",
    categories: ["business", "productivity"],
    /**
     * purpose "any" only, deliberately.
     *
     * These two files are the right pixel sizes but were drawn as plain
     * logos, with no maskable safe zone (the inner 80% circle Android crops
     * an adaptive icon to). Declaring them "maskable" to satisfy a Lighthouse
     * hint would trade a small logo inside a white circle for a logo cropped
     * through the wordmark, which is strictly worse. A padded
     * logo-maskable-512.png is a small design task; until it exists, saying
     * "any" is the honest declaration. tests/manifest-route.test.ts pins this
     * so a future audit-chasing change cannot quietly flip it.
     */
    icons: [
      { src: "/logo-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/logo-512.png", sizes: "512x512", type: "image/png", purpose: "any" }
    ]
  };
}
