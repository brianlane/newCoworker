/**
 * Data-driven comparison pages: /compare lists every entry; each entry
 * renders at /compare/[slug] from the shared template.
 *
 * Adding a comparison = adding one object here PLUS its copy under
 * `marketing.compare.<i18nKey>` in messages/en.json and messages/es.json
 * (metaTitle, metaDescription, ogTitle, ogDescription, name, teaser,
 * heroEyebrow, heroTitle, heroHighlight, heroSubtitle, themColumn,
 * row1..rowN {label,us,them} with N = verdicts.length, themCardTitle,
 * themCard1..M, usCardTitle, usCard1..M with M = cardBullets,
 * faq1..faqK {q,a} with K = faqCount, ctaTitle, ctaSubtitle, plus
 * stat1..stat4 Value/Label when statBand is set and reviewsNote when
 * reviewsNote is set). tests/compare-pages.test.ts derives the required
 * keys from these declared counts, so a mismatch fails in CI.
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
  /** Verdicts for row1..rowN; the template renders one row per verdict. */
  verdicts: readonly RowVerdict[];
  /**
   * Renders the four-stat band (stat1..stat4 `Value`/`Label` keys) between
   * the hero and the table. Values may interpolate {starterMonthly} and
   * {standardMonthly}.
   */
  statBand?: boolean;
  /** FAQ entries (faq1..faqN). Defaults to DEFAULT_FAQ_COUNT. */
  faqCount?: number;
  /**
   * Bullets per difference card (themCard1..N / usCard1..N). Defaults to
   * DEFAULT_CARD_BULLETS.
   */
  cardBullets?: number;
  /**
   * Replaces the shared sourced-figures note under the difference cards with
   * the entry's own rich `reviewsNote` key (<em> and <link> markup, the link
   * pointing at /onboard).
   */
  reviewsNote?: boolean;
};

export const DEFAULT_FAQ_COUNT = 3;
export const DEFAULT_CARD_BULLETS = 3;

export const COMPARISONS: CompareDef[] = [
  {
    // gohighlevel.com pricing + HighLevel support portal, July 2026: $97/
    // $297/$497 base plans; AI Employee Unlimited $97/mo per location; SMS,
    // email, voice, and premium AI usage billed separately.
    slug: "gohighlevel",
    i18nKey: "gohighlevel",
    verdicts: ["us", "us", "us", "tie", "us", "us", "us", "them", "them", "tie"],
    statBand: true,
    faqCount: 5,
    cardBullets: 4,
    reviewsNote: true
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
  },
  {
    // smith.ai/pricing and smith.ai/ai-receptionist, August 2026.
    // AI-only plans: free for 25 calls/mo then $3.00/call, $150/mo at
    // $2.00/call, $500/mo at $1.67/call. Live receptionists: Starter $300/mo
    // for 30 calls ($11.50 over), Basic $810/90 ($10.50), Pro $2,100/300
    // ($8.50), Enterprise custom. Month to month, no setup fee, 30-day
    // money-back up to $1,000, 10% off on a 12-month commitment. Add-ons are
    // per call (booking $1.50, Spanish line $1.00, recording $0.25). Web chat
    // and outreach campaigns are separate products on their own plans.
    // Concedes two rows: 500+ North America receptionists to escalate to, and
    // a genuinely free AI tier. We have neither.
    slug: "smith-ai",
    i18nKey: "smithAi",
    verdicts: ["us", "tie", "us", "them", "them", "us"]
  }
];

export function getComparison(slug: string): CompareDef | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}
