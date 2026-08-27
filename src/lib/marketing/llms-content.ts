/**
 * The llms.txt pair served at /llms.txt and /llms-full.txt.
 *
 * An assistant that reads us gets a compact, current, accurate brief instead
 * of whatever it can scrape from marketing pages. Composed here rather than
 * kept as a static file in public/ because the facts it states (prices,
 * included usage) live in code and WILL drift: the static file it replaced
 * still advertised the pre-relaunch tiers.
 *
 * Pure by design: the route supplies blog posts and industries, so this
 * module needs no DB and no i18n catalog, and stays trivially testable.
 */

import { getPeriodPricing } from "@/lib/plans/tier";
import { TIER_LIMITS } from "@/lib/plans/limits";
import { PRIORITY_SUPPORT_MONTHLY_CENTS } from "@/lib/plans/priority-support";
import { formatPriceCents, formatPricePerMonth } from "@/lib/pricing";
import { SITE_URL } from "./site-url";

export { SITE_URL } from "./site-url";

export type LlmsBlogPost = {
  slug: string;
  title: string;
  excerpt: string | null;
};

export type LlmsIndustry = {
  slug: string;
  name: string;
  teaser: string;
};

/** "$99.00/mo" for the cheapest committed rate on a tier. */
function committedRate(tier: "starter" | "standard"): string {
  return formatPricePerMonth(getPeriodPricing(tier, "biennial").monthlyCents);
}

function monthlyRate(tier: "starter" | "standard"): string {
  return formatPricePerMonth(getPeriodPricing(tier, "monthly").monthlyCents);
}

function includedVoiceMinutes(tier: "starter" | "standard"): number {
  return Math.round(TIER_LIMITS[tier].voiceIncludedSecondsPerStripePeriod / 60);
}

const SUMMARY =
  "New Coworker gives a growing business a 24/7 AI coworker that answers phone " +
  "calls with human-level conversation, replies to texts and emails, books " +
  "appointments on the business's real calendar, qualifies and routes leads to " +
  "the right teammate, and remembers every customer permanently. Each business's " +
  "AI coworker runs on its own dedicated private server, so one tenant's data is " +
  "physically isolated from every other tenant's.";

/** Pricing sentences, derived so they cannot contradict the pricing page. */
function pricingLines(): string[] {
  return [
    `- Starter: from ${committedRate("starter")} on a 24-month term (${monthlyRate("starter")} month to month), ` +
      `including ${includedVoiceMinutes("starter")} voice minutes and ${TIER_LIMITS.starter.smsPerMonth} texts a month, ` +
      `and ${TIER_LIMITS.starter.maxConcurrentCalls} call at a time.`,
    `- Standard: from ${committedRate("standard")} on a 24-month term (${monthlyRate("standard")} month to month), ` +
      `including ${includedVoiceMinutes("standard")} voice minutes and ${TIER_LIMITS.standard.smsPerMonth} texts a month, ` +
      `and up to ${TIER_LIMITS.standard.maxConcurrentCalls} calls at a time.`,
    "- Enterprise: custom pricing, with multi-tenant agency setups, white-label dashboards, " +
      "SLAs, physical data residency (including Canada and bring-your-own-server), and branded RCS messaging.",
    "- Every paid plan carries a 30-day money-back guarantee. 12 and 24-month terms are charged " +
      "in full at checkout because the dedicated server is prepaid for the whole term; included " +
      "usage still refills every month, together on the billing date.",
    `- Priority phone & video support: a ${formatPriceCents(PRIORITY_SUPPORT_MONTHLY_CENTS)} per month add-on ` +
      "on Starter and Standard, billed separately from the plan and cancelable any time; " +
      "included permanently on Enterprise.",
    `- Live prices are on ${SITE_URL}/pricing, which is the authority if this file is stale.`
  ];
}

const CAPABILITY_LINES = [
  "- Voice: answers inbound calls in real time, transfers warmly to a human, takes messages, " +
    "knows when a voicemail answered instead of a person and can leave one, " +
    "follows up by text, and can interpret live between a caller and a staff member " +
    "who do not share a language (live interpretation: Standard plan and up).",
  "- Messaging: two-way SMS and a dedicated email address per business on every plan; " +
    "AI replies on Messenger, Instagram DM, WhatsApp, website chat, and comments on " +
    "Instagram and Facebook posts (publicly or by private DM) on Standard and up.",
  "- Scheduling: books, reschedules, and cancels on Google Calendar, Microsoft 365, CalDAV, Calendly (multiple accounts), Vagaro, or Acuity Scheduling, " +
    "adds a Zoom or Google Meet link to video bookings, " +
    "plus a public self-serve booking page with confirmations, reminders, and a cancellation waitlist for businesses with no calendar tool at all, " +
    "and a shared team calendar with a feed anyone on the roster can subscribe to.",
  "- Memory: a permanent per-business knowledge base plus a customer knowledge graph, so the coworker " +
    "remembers what was said months ago on any channel.",
  "- Automation (AiFlows): multi-step follow-up sequences triggered by a new lead, a missed call, " +
    "a webhook (Standard plan and up), a calendar event, or an inbound message, " +
    "with round-robin routing to a staff roster. Speed to lead: the coworker can phone a brand-new " +
    "lead within seconds and warm-transfer to whichever teammate claims it (outbound AI calls: Standard plan and up). " +
    "Prospecting: it finds local businesses and emails them, with owner-editable drafts (Standard plan and up).",
  "- Integrations: Zapier (8,000+ apps), Google Workspace, Microsoft 365, Zoom, " +
    "Slack (the coworker answers DMs and mentions and takes approvals there; Standard plan and up), " +
    "and Meta Lead Ads through a direct first-party Facebook Page connect in the dashboard (no bridge account needed; " +
    "Zapier or Make.com bridges still work), a public REST API, and webhooks " +
    "(Zapier, Meta lead ads, lead webhooks, the REST API: Standard plan and up), " +
    "plus a Claude connector (remote MCP) and a ChatGPT app so an owner's assistant can act on the business's behalf.",
  "- Custom tables: owners define their own tables and lists, the coworker reads and updates them as it works " +
    "(every AI change can be undone), and they are reachable from Claude and ChatGPT through the connector.",
  "- Owner self-serve: an Ask AI companion on every dashboard page answers from the business's own " +
    "account data and can change settings (hours, channel tool policies) when the owner asks.",
  "- Languages: the owner dashboard is English or Spanish, the owner picks the language the coworker opens with, " +
    "and the coworker replies to each customer in the customer's own language."
];

const DIFFERENTIATOR_LINES = [
  "- Dedicated per-business server: not a shared multi-tenant database. Each business gets its own " +
    "machine, its own SSH keypair, its own gateway credential, and an outbound-only tunnel.",
  "- Customer conversations are not used to train models.",
  "- It works as a coworker rather than a script: it reads the business's own knowledge, uses tools, " +
    "and escalates to a human when a person is actually needed.",
  "- Enterprise data residency puts customer content on a server in the required country, or on hardware the customer owns, " +
    "with encrypted backups whose key the customer can hold."
];

const PAGES: { path: string; label: string; note: string }[] = [
  { path: "/", label: "Home", note: "product overview" },
  { path: "/features", label: "Features", note: "voice, messaging, intelligence, automation, and platform capabilities" },
  { path: "/pricing", label: "Pricing", note: "plans, feature comparison, and billing FAQ" },
  { path: "/integrations", label: "Integrations", note: "Meta lead ads, Zapier, Google, Microsoft, Zoom, Slack, Claude, ChatGPT, API, and webhooks" },
  { path: "/industries", label: "Industries", note: "how the coworker is used per industry" },
  {
    path: "/compare",
    label: "Comparisons",
    note: "New Coworker against GoHighLevel, Follow Up Boss, Smith.ai, Zinng, Marblism, and phone answering services, with sourced figures and where each one wins"
  },
  { path: "/blog", label: "Blog", note: "product updates, tutorials, and small-business advice" },
  { path: "/faq", label: "FAQ", note: "product, setup, privacy, and billing questions" },
  { path: "/security", label: "Security", note: "buyer-facing security posture: isolation, encryption, and privacy lifecycle" },
  { path: "/about", label: "About", note: "mission and principles" },
  { path: "/contact", label: "Contact", note: "sales, support, and partnerships" },
  { path: "/onboard", label: "Get started", note: "self-serve signup" }
];

function pageLines(): string[] {
  return PAGES.map((p) => `- [${p.label}](${SITE_URL}${p.path}): ${p.note}`);
}

function industryLines(industries: LlmsIndustry[]): string[] {
  return industries.map(
    (i) => `- [${i.name}](${SITE_URL}/industries/${i.slug}): ${i.teaser}`
  );
}

/**
 * The short index. Kept under a page so an assistant with a tight budget
 * still gets the whole thing.
 */
export function buildLlmsTxt(): string {
  return [
    "# New Coworker",
    "",
    `> ${SUMMARY}`,
    "",
    "## What it does",
    "",
    ...CAPABILITY_LINES,
    "",
    "## Plans",
    "",
    ...pricingLines(),
    "",
    "## Pages",
    "",
    ...pageLines(),
    "",
    "## Optional",
    "",
    `- [Full details](${SITE_URL}/llms-full.txt): the same brief with industry pages and recent articles`,
    ""
  ].join("\n");
}

/** The long form: adds why-us, industries, and the current article list. */
export function buildLlmsFullTxt(input: {
  posts: LlmsBlogPost[];
  industries: LlmsIndustry[];
}): string {
  const blogSection =
    input.posts.length > 0
      ? [
          "## Recent articles",
          "",
          ...input.posts.map((p) => {
            const excerpt = p.excerpt?.trim();
            const suffix = excerpt ? `: ${excerpt}` : "";
            return `- [${p.title}](${SITE_URL}/blog/${p.slug})${suffix}`;
          }),
          ""
        ]
      : [];

  return [
    "# New Coworker",
    "",
    `> ${SUMMARY}`,
    "",
    "## What it does",
    "",
    ...CAPABILITY_LINES,
    "",
    "## What makes it different",
    "",
    ...DIFFERENTIATOR_LINES,
    "",
    "## Plans",
    "",
    ...pricingLines(),
    "",
    "## Who it is for",
    "",
    ...industryLines(input.industries),
    "",
    "## Pages",
    "",
    ...pageLines(),
    "",
    ...blogSection
  ].join("\n");
}
