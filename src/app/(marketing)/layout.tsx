import { SectionMessages } from "@/components/i18n/SectionMessages";

/**
 * The `(marketing)` route group exists for exactly one reason: these pages
 * share the public nav/footer/contact/pricing client components, and this
 * layout ships their translation namespaces without dragging the dashboard,
 * admin, or email catalogs along (see src/i18n/client-messages.ts). The group
 * changes no URLs.
 *
 * A page belongs here if it renders MarketingNav/MarketingFooter or another
 * client component using `marketing.*` translations. Pages that only use
 * translations server-side (privacy, terms, security) stay outside: server
 * rendering reads the request config, not this provider.
 */
export default function MarketingLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return <SectionMessages section="marketing">{children}</SectionMessages>;
}
