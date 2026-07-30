/**
 * scar-fairy-knowledge-content.ts: the canonical Scar Fairy identity.md and the
 * soul.md repairs, split out of patch-scar-fairy-knowledge.ts so tests can
 * import the pure builders without executing the script's CLI body. Same split
 * as kyp-offer-definition.ts / patch-kyp-offer-branch.ts.
 *
 * WHY IDENTITY AND NOT SOUL. The dashboard Memory page
 * (src/components/dashboard/MemoryEditor.tsx) exposes four surfaces, and the
 * split is not stylistic:
 *
 *   soul_md      "Core personality, ethics, and communication style"
 *   identity_md  "Business name, market, SERVICES, team info"
 *   memory_md    "Accumulated business knowledge"
 *   website_md   the crawl of scarfairy.com
 *
 * src/lib/memory/kg-sources.ts pins `identity: { status: "extracted", trust: 3 }`,
 * the same tier as owner chat and above website and documents (both 2). Skin
 * concerns, modalities, and bundle prices are services, so they belong in
 * identity_md, where they reach the knowledge graph at the highest trust and
 * supersedence guarantees a lead's claim can never overwrite them.
 *
 * soul.md is therefore REPAIRED here, not expanded. Two onboarding defects:
 *
 *   1. Its "## Response Goals" section was compiled with four FAQ *questions*
 *      ("Are the results permanent?" and friends) instead of goals. Those are
 *      already correctly held in memory_md's FAQ section.
 *   2. Its white-glove block carried the never-customized placeholder greeting
 *      ("Hi name.  Thanks for contacting us.") and a qualification question
 *      whose text was duplicated mid-sentence ("Are mornings or afternoons or
 *      mornings or afternoons better for you?").
 *
 * A third defect is a genuine contradiction rather than a typo: the block told
 * the coworker to hand off on "Quoting prices or discounts", while the lead
 * flow this ships alongside texts leads a bundle price directly. The repair
 * names the three approved prices and narrows the handoff to everything else
 * about money.
 *
 * Facts below come from the account's own website_md crawl and memory_md, plus
 * the three bundle prices from the owner. Nothing here is invented: in
 * particular the packages are listed with their prices only, because which
 * device each bundle uses was never established.
 */
import { replaceWhiteGloveBlock, wrapWhiteGloveBlock } from "../../src/lib/white-glove/apply.ts";

/** The three bundles, single source of truth for both documents. */
export const SCAR_FAIRY_BUNDLES: ReadonlyArray<{ name: string; price: string }> = [
  { name: "Melasma Bundle Treatment", price: "$499" },
  { name: "Vaginal Rejuvenation Bundle Treatment", price: "$299" },
  { name: "Back to School Acne Bundle Treatment", price: "$399" }
] as const;

/**
 * Replace the body of a `## <heading>` section, leaving the heading and every
 * other section untouched. Returns the document unchanged when the heading is
 * absent, so a re-run against an already-repaired or hand-edited document is
 * a no-op rather than a surprise append.
 */
export function replaceMarkdownSection(doc: string, heading: string, body: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return doc;

  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ") && !lines[end].startsWith("<!--")) {
    end += 1;
  }
  return [...lines.slice(0, start + 1), ...body.split("\n"), "", ...lines.slice(end)].join("\n");
}

/** Real response goals, replacing the FAQ questions onboarding put there. */
const RESPONSE_GOALS = [
  "- Understand which skin or body concern the person is writing about before recommending anything.",
  "- Get the right people booked into the free consultation, which is where every bundle starts.",
  "- Answer questions about the studio, the bundles, and what a treatment targets, using identity.md and memory.md.",
  "- Hand anything clinical, custom-priced, or uncertain to Selena rather than guessing."
].join("\n");

/** The corrected white-glove block body (markers are added by the wrapper). */
function whiteGloveBlockBody(): string {
  const priceLines = SCAR_FAIRY_BUNDLES.map((b) => `- ${b.name}: ${b.price}`).join("\n");
  return [
    "## White-glove build (from the signed build document)",
    "",
    "### First message & qualification",
    '- Meta lead-form leads are handled by the "Lead follow-up (white-glove build)" AiFlow, not',
    "  improvised. That flow gives the lead three minutes to book on their own, then sends one text",
    "  and one email naming their bundle and its price.",
    "- For every other inbound, open warmly, confirm the concern, and move toward the free consultation.",
    "- Ask AT MOST these questions before booking (fewer questions means fewer leads lost):",
    "  1. What are you hoping to work on?",
    "  2. Do mornings or afternoons work better for you?",
    "- If the lead asks to talk to someone, stop asking questions and book immediately.",
    "",
    "### Prices you may quote",
    "These three bundle prices are approved and may be quoted directly:",
    priceLines,
    "Every bundle starts with a free consultation. Anything else about money (discounts, custom",
    "packages, payment plans, per-session pricing, refunds) goes to Selena.",
    "",
    "### Hand off to a human immediately (never improvise) on:",
    "- Custom or discounted pricing, payment plans, refunds",
    "- Professional, licensed, or medical advice, including medications, pregnancy, and whether",
    "  GLP-1s or peptides are safe during treatment",
    "- Naming or diagnosing a skin condition",
    "- Complaints or disputes",
    "- Cancellations",
    "- Any time the lead asks for a person",
    "- Any time the lead sounds frustrated"
  ].join("\n");
}

/**
 * Repair soul.md in place. Idempotent: both edits are replacements keyed on
 * structure that survives the edit, so re-running converges. Owner-authored
 * text outside the Response Goals section and the white-glove markers is never
 * touched.
 */
export function buildScarFairySoulMd(currentSoul: string): string {
  const withGoals = replaceMarkdownSection(currentSoul, "Response Goals", RESPONSE_GOALS);
  return replaceWhiteGloveBlock(withGoals, wrapWhiteGloveBlock(whiteGloveBlockBody()));
}

/**
 * The canonical identity.md. Written whole rather than patched, so a re-run
 * converges byte-for-byte. That also means an owner edit made in the dashboard
 * between runs is overwritten: re-run this deliberately, and read the previous
 * value the script prints before you do.
 */
export function buildScarFairyIdentityMd(): string {
  const bundleLines = SCAR_FAIRY_BUNDLES.map((b) => `- ${b.name}: ${b.price}`).join("\n");
  return [
    "# identity.md",
    "Business Name: Scar Fairy",
    "Industry: Beauty Spa (private skin correction studio)",
    "Owner / Primary Contact: Selena Breed",
    // Carried over from onboarding rather than dropped: it is the owner's own
    // business line, and losing an owner-provided fact in a rewrite is a
    // regression even when the rewrite is otherwise an expansion.
    "Business Phone: +14043199038",
    "Location: Coral Gables, FL",
    "Service Area: Miami and Coral Gables, FL",
    "Team Size: 4-5",
    "Website: https://scarfairy.com/",
    "",
    "## Snapshot",
    "Scar Fairy is a private, results-driven skin correction studio in Coral Gables, Florida,",
    "founded by Selena Breed. The studio treats all skin tones, with particular focus on deeper",
    "and melanin-rich complexions (Fitzpatrick types IV and V) that are often underserved or",
    "mistreated by traditional aesthetic clinics.",
    "",
    "## Skin and body concerns treated",
    "- Melasma",
    "- Hyperpigmentation",
    "- Acne and active breakouts",
    "- Post-acne marks and acne scarring",
    "- Scars",
    "- Stretch marks",
    "- Ingrown hairs",
    "- Uneven skin texture",
    "- Rosacea",
    "",
    "## Modalities and equipment",
    "- Aerolase Neo Elite: FDA-cleared 1064 nm laser, used to treat melasma, hyperpigmentation,",
    "  and rosacea without damaging deeper skin tones.",
    "- Artemis T Shape 2: body aesthetics.",
    "- Customized chemical peels.",
    "",
    "## Bundle packages and pricing",
    bundleLines,
    "",
    "Every bundle starts with a free in-person consultation, a skin analysis for facial concerns",
    "or a body consultation for body work, to confirm the bundle is the right fit before anything",
    "is booked. The prices above are the current bundle prices and are approved to quote.",
    "",
    "## Customer types",
    "- All age groups for laser services",
    "- Ages 25 to 100 for body aesthetics using the Artemis T Shape 2",
    "",
    "## Booking",
    "Consultations and treatments are booked through Vagaro. Meta lead-form leads are worked by",
    'the "Lead follow-up (white-glove build)" AiFlow.',
    "",
    "## How inquiries are handled",
    "Selena personally handles all initial inquiries. Client requests and intake run over text,",
    "email, and calendar. There is no separate CRM.",
    ""
  ].join("\n");
}
