import type { Metadata } from "next";
import "./globals.css";

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
      { url: "/transparentIcon.png", type: "image/png", sizes: "32x32" },
      { url: "/transparentIcon.png", type: "image/png", sizes: "192x192" },
      { url: "/transparentIcon.png", type: "image/png", sizes: "512x512" }
    ],
    shortcut: [{ url: "/transparentIcon.png", type: "image/png" }],
    apple: [{ url: "/transparentIcon.png", type: "image/png", sizes: "180x180" }]
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
      <body>{children}</body>
    </html>
  );
}
