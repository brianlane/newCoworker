import type { Metadata, Viewport } from "next";
import { Geist, Inter } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import {
  GLOBAL_CLIENT_MESSAGE_PATHS,
  pickMessages
} from "@/i18n/client-messages";
import { JsonLd } from "@/components/marketing/JsonLd";
import "./globals.css";
import { SITE_URL } from "@/lib/marketing/site-url";

/**
 * Brand faces, self-hosted at build by next/font (zero runtime requests,
 * metric-adjusted fallbacks so text does not shift when they load). Inter
 * carries body text; Geist is the display face for headings via the
 * `font-display` utility (it replaced Space Grotesk, whose quirky letterforms
 * read off-brand: Geist is the neutral, premium grotesque designed for dark
 * interfaces, and pairs with Inter's near-identical metrics). globals.css
 * maps both variables into the Tailwind theme, and the system stack stays as
 * the fallback throughout.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap"
});
const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap"
});

const ORGANIZATION_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": `${SITE_URL}/#organization`,
  name: "New Coworker",
  url: SITE_URL,
  logo: `${SITE_URL}/logo.png`,
  description:
    "New Coworker gives growing businesses a 24/7 AI employee that answers calls, texts, and emails, books appointments, and remembers every customer.",
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer support",
    url: `${SITE_URL}/contact`
  }
};

const WEBSITE_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": `${SITE_URL}/#website`,
  name: "New Coworker",
  url: SITE_URL,
  publisher: { "@id": `${SITE_URL}/#organization` }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Paints the browser UI (mobile address bar, installed-app title bar) in
  // the site's own background instead of default white.
  themeColor: "#0d2235"
};

export const metadata: Metadata = {
  // Resolves every page's relative `alternates.canonical` and og:url.
  metadataBase: new URL(SITE_URL),
  title: {
    default: "New Coworker",
    template: "%s | New Coworker"
  },
  description: "AI coworker that answers calls, texts, and emails around the clock for growing businesses.",
  applicationName: "New Coworker",
  keywords: [
    "AI employee",
    "AI call answering",
    "AI coworker",
    "business automation",
    "virtual assistant for business"
  ],
  icons: {
    icon: [
      { url: "/logo-32.png", type: "image/png", sizes: "32x32" },
      { url: "/logo-192.png", type: "image/png", sizes: "192x192" },
      { url: "/logo-512.png", type: "image/png", sizes: "512x512" }
    ],
    shortcut: ["/logo-32.png"],
    apple: [{ url: "/logo-180.png", type: "image/png", sizes: "180x180" }]
  },
  openGraph: {
    type: "website",
    title: "New Coworker",
    description: "Your AI employee that never sleeps.",
    siteName: "New Coworker",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "New Coworker social preview"
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: "New Coworker",
    description: "Your AI employee that never sleeps.",
    images: ["/twitter-image"]
  },
  robots: {
    index: true,
    follow: true
  }
};

export default async function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} className={`${inter.variable} ${geist.variable}`}>
      <body>
        {/*
          Only the global client subset (~465 bytes) ships from here. Handing
          this provider the full `messages` catalog would serialize all ~165KB
          of it into every page's HTML, which is exactly what it used to do.
          Sections layer their own subsets in nested layouts; the mapping and
          its guard test live in src/i18n/client-messages.ts.
        */}
        <NextIntlClientProvider
          locale={locale}
          messages={pickMessages(messages, GLOBAL_CLIENT_MESSAGE_PATHS)}
        >
          <JsonLd data={ORGANIZATION_JSON_LD} />
          <JsonLd data={WEBSITE_JSON_LD} />
          {children}
        </NextIntlClientProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
