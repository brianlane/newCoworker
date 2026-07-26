import { describe, expect, it } from "vitest";
import {
  AI_CRAWLERS,
  AI_CRAWLER_TOKENS,
  AI_REFERRERS,
  matchAiCrawler,
  matchAiReferrer
} from "@/lib/marketing/ai-crawlers";
import robots from "@/app/robots";

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

describe("robots.txt", () => {
  const rules = () => {
    const r = robots().rules;
    return Array.isArray(r) ? r : [r];
  };

  it("still hides the authenticated surfaces from the wildcard group", () => {
    const wildcard = rules().find((r) => r.userAgent === "*");
    expect(wildcard?.allow).toBe("/");
    expect(wildcard?.disallow).toEqual(["/dashboard", "/admin", "/api"]);
  });

  it("gives the AI agents their own allow group", () => {
    const aiRule = rules().find((r) => Array.isArray(r.userAgent));
    expect(aiRule?.userAgent).toEqual(AI_CRAWLER_TOKENS);
    expect(aiRule?.allow).toBe("/");
  });

  it("repeats the disallows in the AI group, since a matched group ignores *", () => {
    const wildcard = rules().find((r) => r.userAgent === "*");
    const aiRule = rules().find((r) => Array.isArray(r.userAgent));
    expect(aiRule?.disallow).toEqual(wildcard?.disallow);
  });

  it("points at the sitemap", () => {
    expect(robots().sitemap).toBe("https://newcoworker.com/sitemap.xml");
  });
});
