import type { Metadata, Viewport } from "next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { JsonLd } from "@/components/marketing/JsonLd";
import "./globals.css";

const SITE_URL = "https://newcoworker.com";

// Sitewide schema.org identity: helps search engines and AI answer engines
// attribute pages to the company and find the contact channel.
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
  initialScale: 1
};

export const metadata: Metadata = {
  metadataBase: new URL("https://newcoworker.com"),
  title: {
    default: "New Coworker",
    template: "%s | New Coworker"
  },
  description: "AI coworker that answers calls, texts, and emails around the clock for growing businesses.",
  applicationName: "New Coworker",
  keywords: [
    "AI employee",
    "AI call answering",
    "AI receptionist",
    "business automation",
    "virtual assistant for business"
  ],
  icons: {
    icon: [
      { url: "/logo.png", type: "image/png", sizes: "32x32" },
      { url: "/logo.png", type: "image/png", sizes: "192x192" },
      { url: "/logo.png", type: "image/png", sizes: "512x512" }
    ],
    shortcut: ["/logo.png"],
    apple: [{ url: "/logo.png", type: "image/png", sizes: "180x180" }]
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

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <JsonLd data={ORGANIZATION_JSON_LD} />
        <JsonLd data={WEBSITE_JSON_LD} />
        {children}
        <SpeedInsights />
      </body>
    </html>
  );
}
