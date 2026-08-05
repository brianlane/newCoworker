import { SectionMessages } from "@/components/i18n/SectionMessages";

/**
 * The `(auth)` route group bundles login, signup, reset-password, and
 * verify-email so their shared `auth` translation namespace ships from one
 * provider (see src/i18n/client-messages.ts). URLs are unchanged. The admin
 * login is deliberately not here: it renders no translated client components.
 */
export default function AuthLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return <SectionMessages section="auth">{children}</SectionMessages>;
}
