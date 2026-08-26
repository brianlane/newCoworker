import { SectionMessages } from "@/components/i18n/SectionMessages";

/**
 * The `(marketing)` route group exists for exactly one reason: these pages
 * share the public nav/footer/contact/pricing client components, and this
 * layout ships their translation namespaces without dragging the dashboard,
 * admin, or email catalogs along (see src/i18n/client-messages.ts). The group
 * changes no URLs.
 *
 * A page belongs here if it renders MarketingNav/MarketingFooter or another
 * client component using `marketing.*` translations. That now includes the
 * legal pages (privacy, terms, security): LegalPage renders the shared
 * chrome, whose client components need this provider. Server-side
 * translation calls are unaffected either way, they read the request config.
 */
export default function MarketingLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return <SectionMessages section="marketing">{children}</SectionMessages>;
}
