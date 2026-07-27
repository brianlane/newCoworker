import { describe, expect, it } from "vitest";
import {
  AI_ANSWER_CRAWLER_TOKENS,
  AI_CRAWLERS,
  AI_CRAWLER_TOKENS,
  AI_REFERRERS,
  OBSERVABLE_AI_OPERATORS,
  AI_TRAINING_CRAWLER_TOKENS,
  matchAiCrawler,
  matchAiReferrer
} from "@/lib/marketing/ai-crawlers";

describe("AI crawler registry", () => {
  it("publishes a robots token for every entry, with no duplicates", () => {
    expect(AI_CRAWLER_TOKENS).toHaveLength(AI_CRAWLERS.length);
    expect(new Set(AI_CRAWLER_TOKENS).size).toBe(AI_CRAWLER_TOKENS.length);
    for (const token of AI_CRAWLER_TOKENS) {
      expect(token.trim()).toBe(token);
      expect(token).not.toBe("");
    }
  });

  it("covers the assistants buyers actually ask", () => {
    for (const token of ["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot"]) {
      expect(AI_CRAWLER_TOKENS).toContain(token);
    }
  });

  it("keeps every header matcher lowercase so matching is case-insensitive", () => {
    for (const crawler of AI_CRAWLERS) {
      if (crawler.match !== null) {
        expect(crawler.match).toBe(crawler.match.toLowerCase());
      }
    }
  });

  it("splits cleanly into answer engines and training crawlers", () => {
    // The two lists are complements, which is what makes it impossible to
    // emit an allow and a disallow for the same token.
    expect([...AI_ANSWER_CRAWLER_TOKENS, ...AI_TRAINING_CRAWLER_TOKENS].sort()).toEqual(
      [...AI_CRAWLER_TOKENS].sort()
    );
    for (const token of AI_TRAINING_CRAWLER_TOKENS) {
      expect(AI_ANSWER_CRAWLER_TOKENS).not.toContain(token);
    }
  });

  it("classifies Amazonbot as training, matching how it is treated", () => {
    // It was `index`, which put it on the allow side while the policy
    // blocked it. `kind` is the single source of the split now, so a wrong
    // kind is a wrong robots.txt.
    expect(AI_CRAWLERS.find((c) => c.token === "Amazonbot")?.kind).toBe("train");
    expect(AI_TRAINING_CRAWLER_TOKENS).toContain("Amazonbot");
  });

  it("keeps the citation-driving engines on the allow side", () => {
    for (const token of [
      "OAI-SearchBot",
      "ChatGPT-User",
      "Claude-SearchBot",
      "Claude-User",
      "PerplexityBot",
      "Perplexity-User"
    ]) {
      expect(AI_ANSWER_CRAWLER_TOKENS).toContain(token);
    }
  });

  it("counts an operator as observable only if something identifies itself", () => {
    // Google's only entry is Google-Extended, a robots.txt opt-out control
    // that never appears in a User-Agent. Treating it as observable would
    // make the admin page report Google as a permanently missing crawler,
    // which reads as an edge block that is not happening.
    expect(OBSERVABLE_AI_OPERATORS).not.toContain("Google");
    expect(OBSERVABLE_AI_OPERATORS).toContain("Apple");
    expect(OBSERVABLE_AI_OPERATORS).toContain("OpenAI");
    expect(OBSERVABLE_AI_OPERATORS).toEqual([...OBSERVABLE_AI_OPERATORS].sort());
    expect(new Set(OBSERVABLE_AI_OPERATORS).size).toBe(OBSERVABLE_AI_OPERATORS.length);
  });

  it("can reach every observable operator through matchAiCrawler", () => {
    // Pins the page's contract: anything it can list as missing must be
    // something matchAiCrawler could have recorded.
    const reachable = new Set(
      AI_CRAWLERS.filter((c) => c.match !== null).map(
        (c) => matchAiCrawler(`bot ${c.match} /1.0`)?.operator
      )
    );
    for (const operator of OBSERVABLE_AI_OPERATORS) {
      expect(reachable).toContain(operator);
    }
  });
});

describe("matchAiCrawler", () => {
  it("identifies an agent from a realistic User-Agent string", () => {
    const hit = matchAiCrawler(
      "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)"
    );
    expect(hit?.token).toBe("PerplexityBot");
    expect(hit?.operator).toBe("Perplexity");
    expect(hit?.kind).toBe("index");
  });

  it("matches regardless of case", () => {
    expect(matchAiCrawler("GPTBOT/1.2")?.token).toBe("GPTBot");
    expect(matchAiCrawler("gptbot/1.2")?.token).toBe("GPTBot");
  });

  it("returns null for a browser, and for missing headers", () => {
    expect(matchAiCrawler("Mozilla/5.0 (Macintosh) Safari/605.1.15")).toBeNull();
    expect(matchAiCrawler("")).toBeNull();
    expect(matchAiCrawler(null)).toBeNull();
    expect(matchAiCrawler(undefined)).toBeNull();
  });

  it("never matches the robots-only opt-out control tokens", () => {
    // Google-Extended and Applebot-Extended exist only in robots.txt; a
    // request never carries them, and treating one as a live hit would
    // invent crawler traffic that did not happen.
    expect(matchAiCrawler("Google-Extended")).toBeNull();
    expect(matchAiCrawler("Applebot-Extended/1.0")?.token).toBe("Applebot");
  });
});

describe("matchAiReferrer", () => {
  it("identifies the AI surface a visitor came from", () => {
    expect(matchAiReferrer("https://chatgpt.com/c/abc123")?.surface).toBe("ChatGPT");
    expect(matchAiReferrer("https://www.perplexity.ai/search/foo")?.surface).toBe("Perplexity");
    expect(matchAiReferrer("https://claude.ai/chat/xyz")?.surface).toBe("Claude");
  });

  it("matches subdomains but not lookalike hosts", () => {
    expect(matchAiReferrer("https://deep.chatgpt.com/x")?.surface).toBe("ChatGPT");
    expect(matchAiReferrer("https://notchatgpt.com/x")).toBeNull();
    expect(matchAiReferrer("https://chatgpt.com.evil.test/x")).toBeNull();
  });

  it("returns null for ordinary referrers, unparseable values, and no referrer", () => {
    expect(matchAiReferrer("https://google.com/search?q=x")).toBeNull();
    expect(matchAiReferrer("not-a-url")).toBeNull();
    expect(matchAiReferrer("")).toBeNull();
    expect(matchAiReferrer(null)).toBeNull();
    expect(matchAiReferrer(undefined)).toBeNull();
  });

  it("has a surface label for every host", () => {
    for (const ref of AI_REFERRERS) {
      expect(ref.surface).not.toBe("");
      expect(ref.host).toBe(ref.host.toLowerCase());
    }
  });
});
