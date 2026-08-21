/**
 * Data-driven comparison pages: /compare lists every entry; each entry
 * without `bespoke` renders at /compare/[slug] from the shared template.
 *
 * Adding a comparison = adding one object here PLUS its copy under
 * `marketing.compare.<i18nKey>` in messages/en.json and messages/es.json
 * (metaTitle, metaDescription, ogTitle, ogDescription, name, teaser,
 * heroEyebrow, heroTitle, heroHighlight, heroSubtitle, themColumn,
 * row1..row6 {label,us,them}, themCardTitle, themCard1..3, usCardTitle,
 * usCard1..3, faq1..3 {q,a}, ctaTitle, ctaSubtitle).
 *
 * COMPETITOR CLAIMS MUST STAY SOURCED AND CURRENT. Every figure below was
 * taken from the vendor's own published pricing in July 2026 (see the note on
 * each entry). An inaccurate competitor claim hurts more than it helps, and
 * an AI assistant that cross-checks us against the vendor's own page and
 * finds us wrong will stop citing us. Re-verify when touching this file.
 */

/** Who a row favors. `tie` renders as a neutral dash on both sides. */
export type RowVerdict = "us" | "them" | "tie";

export type CompareDef = {
  slug: string;
  /** Catalog namespace under marketing.compare. */
  i18nKey: string;
  /** Verdicts for row1..row6, in order. */
  verdicts: [RowVerdict, RowVerdict, RowVerdict, RowVerdict, RowVerdict, RowVerdict];
  /**
   * True when the slug has its own hand-built page instead of rendering
   * through [slug]. Next gives the static route precedence, so the entry is
   * here purely so the index, the sitemap, and llms.txt stay complete.
   */
  bespoke?: boolean;
};

export const COMPARISONS: CompareDef[] = [
  {
    // gohighlevel.com pricing + HighLevel support portal, July 2026.
    slug: "gohighlevel",
    i18nKey: "gohighlevel",
    verdicts: ["us", "us", "us", "us", "them", "us"],
    bespoke: true
  },
  {
    // zinng.ai pricing, July 2026: Essentials $49/300 min, Pro $99/700,
    // Growth $149/1,000, Scale $249/2,000; $0.12/min overage; extra agents
    // $20/mo; spam and transferred calls excluded from the minute count.
    // Month to month, no contract, 7-day trial. HIPAA with a BAA, 63
    // languages, dental PMS integrations (Eaglesoft, Dentrix, Open Dental).
    slug: "zinng",
    i18nKey: "zinng",
    verdicts: ["us", "them", "tie", "us", "us", "us"]
  },
  {
    // marblism.com pricing, July 2026: one flat plan, all six named agents
    // included, $24/mo billed yearly, $33 quarterly, $44 monthly, 50 hours
    // of work included, unlimited businesses, extra seats $14-29/mo.
    // Integrations are Gmail, Outlook, and the social networks. Agents draft
    // and the owner approves.
    slug: "marblism",
    i18nKey: "marblism",
    verdicts: ["us", "them", "us", "us", "us", "us"]
  },
  {
    // followupboss.com/pricing, August 2026: Grow $69/user/mo monthly or
    // $58/user annually, calling add-on $39/user; Pro $499/mo for 10 users
    // ($49 each extra) or $416/mo annually ($41 extra); Platform $1,000/mo for
    // 30 users ($20 extra) or $833/mo annually ($17 extra). Free trial, no
    // contract, cancel any time, 250+ integrations, unlimited contacts.
    // The only entry that concedes two rows: they are a mature CRM and our
    // deals, to-dos, and notes shipped in August 2026.
    slug: "follow-up-boss",
    i18nKey: "followUpBoss",
    verdicts: ["us", "tie", "us", "them", "them", "us"]
  },
  {
    // Category comparison against human answering services and call centers.
    // Deliberately not a named vendor: the buyer question is about the
    // category, and category facts do not go stale.
    slug: "answering-service",
    i18nKey: "answeringService",
    verdicts: ["us", "us", "tie", "us", "us", "tie"]
  }
];

export const COMPARE_ROW_COUNT = 6;

export function getComparison(slug: string): CompareDef | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}
