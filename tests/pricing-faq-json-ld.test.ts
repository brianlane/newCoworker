import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import es from "../messages/es.json";
import { CONTACT_EMAIL } from "@/lib/marketing/contact-email";
import { faqPageJsonLd, stripFaqRichMarkup } from "@/lib/marketing/faq-json-ld";
import { PRICING_FAQ_KEYS, pricingFaqEntries, type PricingFaqTranslate } from "@/lib/marketing/pricing-faqs";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";
import { CANADA_MESSAGING_FEE_MONTHLY_CENTS } from "@/lib/plans/canadian-messaging";
import { MEXICO_MESSAGING_FEE_MONTHLY_CENTS } from "@/lib/plans/mexican-messaging";
import { PRIORITY_SUPPORT_MONTHLY_CENTS } from "@/lib/plans/priority-support";
import { getPeriodPricing } from "@/lib/plans/tier";
import { formatPriceCents, formatPricePerMonth } from "@/lib/pricing";
import { SMS_MONTHLY_CAP_MX } from "../supabase/functions/_shared/sms_monthly_limits";

const PAGE = readFileSync(
  join(import.meta.dirname, "../src/app/(marketing)/pricing/page.tsx"),
  "utf8"
);
const FAQ_PAGE = readFileSync(
  join(import.meta.dirname, "../src/app/(marketing)/faq/page.tsx"),
  "utf8"
);

type PricingCopy = Record<string, string>;

const CATALOGS: [string, PricingCopy][] = [
  ["en", en.marketing.pricing as unknown as PricingCopy],
  ["es", es.marketing.pricing as unknown as PricingCopy]
];

/**
 * Visible pricing FAQ Q&A: every `faq…Q` key under marketing.pricing except
 * the section heading (`faqTitle`). The matching answer is the same stem
 * with a trailing A. That catalog pair is the source of truth the page
 * accordion already renders.
 */
function catalogFaqPairs(copy: PricingCopy): { q: string; a: string }[] {
  return Object.keys(copy)
    .filter((key) => key.startsWith("faq") && key.endsWith("Q"))
    .map((q) => ({ q, a: `${q.slice(0, -1)}A` }));
}

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

function pricingVars() {
  return {
    carrierFee: formatPriceCents(CARRIER_REGISTRATION_FEE_CENTS),
    canadaFeeMonthly: formatPriceCents(CANADA_MESSAGING_FEE_MONTHLY_CENTS),
    mexicoFeeMonthly: formatPriceCents(MEXICO_MESSAGING_FEE_MONTHLY_CENTS),
    prioritySupportPrice: formatPriceCents(PRIORITY_SUPPORT_MONTHLY_CENTS),
    starterRenewal: formatPricePerMonth(
      getPeriodPricing("starter", "biennial").renewalMonthlyCents
    ),
    standardRenewal: formatPricePerMonth(
      getPeriodPricing("standard", "biennial").renewalMonthlyCents
    ),
    mexicoSmsCap: SMS_MONTHLY_CAP_MX,
    contactEmail: CONTACT_EMAIL
  };
}

describe("pricing page FAQPage JSON-LD wiring", () => {
  it("reuses the /faq FAQPage injection pattern", () => {
    expect(FAQ_PAGE).toContain('from "@/components/marketing/JsonLd"');
    expect(FAQ_PAGE).toMatch(/"@type": "FAQPage"/);
    expect(PAGE).toContain('from "@/components/marketing/JsonLd"');
    expect(PAGE).toContain("faqPageJsonLd");
    expect(PAGE).toContain("<JsonLd data={faqJsonLd} />");
  });

  it("feeds the accordion and the schema from the same faq entries", () => {
    expect(PAGE).toContain("<FaqAccordion items={faq} />");
    expect(PAGE).toContain("pricingFaqEntries");
    expect(PAGE).toMatch(/faqPageJsonLd\(faq\)|faqPageJsonLd\(entries\)/);
  });
});

describe.each(CATALOGS)("pricing FAQPage entries match visible FAQs (%s)", (_locale, copy) => {
  const pairs = catalogFaqPairs(copy);
  const values = pricingVars();
  const t: PricingFaqTranslate = (key, interpolations) => interpolate(copy[key], interpolations);
  const entries = pricingFaqEntries(t, values);
  const jsonLd = faqPageJsonLd(entries);

  it("is a FAQPage with one Question per visible pricing FAQ", () => {
    expect(jsonLd["@context"]).toBe("https://schema.org");
    expect(jsonLd["@type"]).toBe("FAQPage");
    expect(PRICING_FAQ_KEYS).toEqual(pairs);
    expect(jsonLd.mainEntity).toHaveLength(pairs.length);
  });

  it("copies each catalog Q&A into the schema, markup stripped, nothing invented", () => {
    for (const [index, { q, a }] of pairs.entries()) {
      expect(typeof copy[q], q).toBe("string");
      expect(typeof copy[a], a).toBe("string");
      expect(copy[q].length).toBeGreaterThan(0);
      expect(copy[a].length).toBeGreaterThan(0);

      const mainEntity = jsonLd.mainEntity as Array<{
        "@type": string;
        name: string;
        acceptedAnswer: { "@type": string; text: string };
      }>;
      const entity = mainEntity[index];
      expect(entity["@type"]).toBe("Question");
      expect(entity.name).toBe(interpolate(copy[q], values));
      expect(entity.acceptedAnswer["@type"]).toBe("Answer");
      expect(entity.acceptedAnswer.text).toBe(stripFaqRichMarkup(interpolate(copy[a], values)));
      expect(entity.acceptedAnswer.text).not.toMatch(/<\/?[a-zA-Z]/);
    }
  });
});

describe("faq JSON-LD helpers", () => {
  it("maps question/plainAnswer items into FAQPage Question nodes", () => {
    const jsonLd = faqPageJsonLd([
      { question: "How much?", plainAnswer: "Plans start at $9.99/mo." }
    ]);
    expect(jsonLd).toEqual({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "How much?",
          acceptedAnswer: { "@type": "Answer", text: "Plans start at $9.99/mo." }
        }
      ]
    });
  });

  it("allows an empty list so a caller with no FAQs does not invent one", () => {
    expect(faqPageJsonLd([])).toEqual({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: []
    });
  });

  it("strips next-intl rich tags so JSON-LD text matches the visible words", () => {
    expect(en.marketing.pricing.faqExtraNumbersA).toContain("<email>");
    expect(en.marketing.pricing.faqWhiteGloveA).toContain("<b>");
    expect(en.marketing.pricing.faqWhiteGloveA).toContain("<link>");
    expect(
      stripFaqRichMarkup(
        "Contact <email>team@example.com</email> to add one to your account."
      )
    ).toBe("Contact team@example.com to add one to your account.");
    expect(stripFaqRichMarkup("<b>White-glove setup</b> covers guided setup.")).toBe(
      "White-glove setup covers guided setup."
    );
    expect(stripFaqRichMarkup("No markup here.")).toBe("No markup here.");
  });
});
