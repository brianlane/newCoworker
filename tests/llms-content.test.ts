import { describe, expect, it } from "vitest";
import {
  buildLlmsFullTxt,
  buildLlmsTxt,
  SITE_URL,
  type LlmsBlogPost,
  type LlmsIndustry
} from "@/lib/marketing/llms-content";
import { getPeriodPricing } from "@/lib/plans/tier";
import { TIER_LIMITS } from "@/lib/plans/limits";
import { formatPricePerMonth } from "@/lib/pricing";

const INDUSTRIES: LlmsIndustry[] = [
  { slug: "real-estate", name: "Real Estate", teaser: "Answer every buyer and seller call." },
  { slug: "law-firms", name: "Law Firms", teaser: "Intake without the answering service." }
];

const POSTS: LlmsBlogPost[] = [
  { slug: "first-post", title: "First Post", excerpt: "A short summary." },
  { slug: "second-post", title: "Second Post", excerpt: null }
];

const full = () => buildLlmsFullTxt({ posts: POSTS, industries: INDUSTRIES });

describe("llms.txt", () => {
  it("opens with the llms.txt shape: an H1 then a blockquote summary", () => {
    const lines = buildLlmsTxt().split("\n");
    expect(lines[0]).toBe("# New Coworker");
    expect(lines[2].startsWith("> ")).toBe(true);
  });

  it("links every marketing page absolutely, since an assistant has no base URL", () => {
    const txt = buildLlmsTxt();
    for (const path of ["/pricing", "/features", "/faq", "/blog", "/onboard"]) {
      expect(txt).toContain(`(${SITE_URL}${path})`);
    }
    expect(txt).not.toMatch(/\]\(\/[a-z]/);
  });

  it("points at the long form", () => {
    expect(buildLlmsTxt()).toContain(`${SITE_URL}/llms-full.txt`);
  });
});

describe("llms pricing stays in lockstep with the pricing code", () => {
  // The static public/llms.txt this replaced went stale silently. These
  // assertions read the same source the pricing page reads, so a tier change
  // that misses this file fails CI instead of misinforming an assistant.
  it.each(["starter", "standard"] as const)("states the real %s rates", (tier) => {
    const committed = formatPricePerMonth(getPeriodPricing(tier, "biennial").monthlyCents);
    const monthly = formatPricePerMonth(getPeriodPricing(tier, "monthly").monthlyCents);
    for (const txt of [buildLlmsTxt(), full()]) {
      expect(txt).toContain(committed);
      expect(txt).toContain(monthly);
    }
  });

  it.each(["starter", "standard"] as const)("states the real %s included usage", (tier) => {
    const minutes = String(Math.round(TIER_LIMITS[tier].voiceIncludedSecondsPerStripePeriod / 60));
    const sms = String(TIER_LIMITS[tier].smsPerMonth);
    const calls = String(TIER_LIMITS[tier].maxConcurrentCalls);
    for (const txt of [buildLlmsTxt(), full()]) {
      expect(txt).toContain(`${minutes} voice minutes`);
      expect(txt).toContain(`${sms} texts a month`);
      expect(txt).toContain(calls);
    }
  });

  it("names the pricing page as the authority, so a stale copy self-corrects", () => {
    expect(buildLlmsTxt()).toContain(`${SITE_URL}/pricing`);
    expect(buildLlmsTxt()).toContain("authority if this file is stale");
  });
});

describe("llms-full.txt", () => {
  it("adds the sections the short index leaves out", () => {
    const txt = full();
    expect(txt).toContain("## What makes it different");
    expect(txt).toContain("## Who it is for");
  });

  it("lists every industry it was given, with its teaser", () => {
    const txt = full();
    for (const industry of INDUSTRIES) {
      expect(txt).toContain(`[${industry.name}](${SITE_URL}/industries/${industry.slug})`);
      expect(txt).toContain(industry.teaser);
    }
  });

  it("lists articles, appending an excerpt only when there is one", () => {
    const txt = full();
    expect(txt).toContain(`- [First Post](${SITE_URL}/blog/first-post): A short summary.`);
    expect(txt).toContain(`- [Second Post](${SITE_URL}/blog/second-post)\n`);
  });

  it("drops a whitespace-only excerpt rather than emitting a bare colon", () => {
    const txt = buildLlmsFullTxt({
      posts: [{ slug: "p", title: "P", excerpt: "   " }],
      industries: INDUSTRIES
    });
    expect(txt).toContain(`- [P](${SITE_URL}/blog/p)\n`);
    expect(txt).not.toContain("/blog/p): ");
  });

  it("omits the articles heading entirely when the blog read came back empty", () => {
    const txt = buildLlmsFullTxt({ posts: [], industries: INDUSTRIES });
    expect(txt).not.toContain("## Recent articles");
    expect(txt).toContain("## Pages");
  });
});

describe("llms copy follows the product rules", () => {
  it("never says the banned product label", () => {
    for (const txt of [buildLlmsTxt(), full()]) {
      expect(txt.toLowerCase()).not.toContain("ai receptionist");
    }
  });

  it("never contains an em dash", () => {
    for (const txt of [buildLlmsTxt(), full()]) {
      expect(txt).not.toContain("\u2014");
    }
  });

  it("qualifies every gated capability with its plan, so an assistant cannot promise a Starter buyer a Standard feature", () => {
    // This file is copy an AI assistant quotes back to prospects. Each claim
    // about a Standard+ feature must carry a plan qualifier on the SAME line,
    // mirroring the Integrations line's existing "Standard plan and up".
    const txt = full();
    const line = (marker: string) => {
      const found = txt.split("\n").find((l) => l.includes(marker));
      expect(found, `no capability line contains "${marker}"`).toBeTruthy();
      return found as string;
    };
    // Live interpretation (#1028), Messenger / IG DM / WhatsApp AI replies
    // (#1029), the website chat widget (#491), and webhook-triggered
    // automation (#993) are Standard+.
    expect(line("interpret live")).toMatch(/Standard/);
    expect(line("Messenger")).toMatch(/Standard/);
    expect(line("website chat")).toMatch(/Standard/);
    expect(line("a webhook")).toMatch(/Standard/);
  });
});
