import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import {
  type SECTION_CLIENT_MESSAGES,
  sectionClientMessages
} from "@/i18n/client-messages";

/**
 * Section-scoped i18n provider for nested layouts.
 *
 * Renders a `NextIntlClientProvider` carrying the global client subset plus
 * this section's namespaces (see src/i18n/client-messages.ts for the mapping
 * and the reasoning). React context resolution means this provider REPLACES
 * the root layout's for everything underneath it, so it must include the
 * global paths too, which `sectionClientMessages` guarantees.
 *
 * The root layout still serializes its own small subset alongside this one.
 * That duplication is ~465 bytes and buys a simple invariant: every route has
 * the global namespaces, whether or not a section layout wraps it.
 */
export async function SectionMessages({
  section,
  children
}: {
  section: keyof typeof SECTION_CLIENT_MESSAGES;
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={sectionClientMessages(messages, section)}
    >
      {children}
    </NextIntlClientProvider>
  );
}
