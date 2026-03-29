import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Choose Your Plan | New Coworker",
  description: "Choose the perfect plan for your AI voice coworker. Handle calls, texts, emails, and more so you can focus on your business.",
  openGraph: {
    title: "Choose Your Plan | New Coworker",
    description: "Choose the perfect plan for your AI voice coworker. Handle calls, texts, emails, and more so you can focus on your business.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Choose Your Plan | New Coworker",
    description: "Choose the perfect plan for your AI voice coworker. Handle calls, texts, emails, and more so you can focus on your business.",
  },
};

export default function OnboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
