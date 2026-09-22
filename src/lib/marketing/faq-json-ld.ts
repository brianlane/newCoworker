/**
 * FAQPage JSON-LD, the shape `/faq` already inlines. Pricing (and any later
 * marketing page with a visible accordion) should feed the same items into
 * this helper so schema cannot drift from the rendered Q&A.
 *
 * `plainAnswer` is the visible answer as text: next-intl rich tags (`<b>`,
 * `<link>`, `<email>`) are stripped so JSON-LD carries the same words the
 * visitor reads, not markup, and never a second invented FAQ string.
 */

export type FaqJsonLdItem = {
  question: string;
  plainAnswer: string;
};

/** Drop next-intl rich tags, keep the inner text the accordion already shows. */
export function stripFaqRichMarkup(text: string): string {
  return text.replace(/<\/?[a-zA-Z][\w-]*[^>]*>/g, "");
}

export function faqPageJsonLd(items: FaqJsonLdItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.plainAnswer }
    }))
  };
}
