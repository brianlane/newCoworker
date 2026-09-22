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

/**
 * next-intl rich tags the pricing FAQ catalog actually uses. Named
 * literals, not a general HTML sanitizer: a catch-all tag regex is the
 * incomplete-sanitization pattern CodeQL flags, and this copy is ours.
 */
const RICH_TAGS = ["b", "link", "email"] as const;

/** Drop next-intl rich tags, keep the inner text the accordion already shows. */
export function stripFaqRichMarkup(text: string): string {
  let out = text;
  for (const tag of RICH_TAGS) {
    out = out.replaceAll(`<${tag}>`, "").replaceAll(`</${tag}>`, "");
  }
  return out;
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
