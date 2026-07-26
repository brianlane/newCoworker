/**
 * The AI assistants that read newcoworker.com, and the AI surfaces that send
 * us people.
 *
 * One registry backs three consumers so they cannot drift: the robots.txt
 * allow group (src/app/robots.ts), the live access probe
 * (debug/aeo-crawler-probe.ts), and AI-traffic attribution
 * (src/lib/marketing/ai-traffic.ts).
 */

/**
 * `index`: fetches pages to answer questions with citations, the traffic we
 * actually want. `train`: corpus collection. `fetch`: a one-off retrieval a
 * human just asked for, so it is a visit more than a crawl.
 */
export type AiCrawlerKind = "index" | "train" | "fetch";

export type AiCrawlerDef = {
  /** Exact token for a robots.txt `User-agent:` line. */
  token: string;
  /**
   * Lowercase substring identifying this agent in a User-Agent header, or
   * null for tokens that only ever exist as a robots.txt opt-out control
   * (Google-Extended, Applebot-Extended) and never identify a request.
   */
  match: string | null;
  operator: string;
  kind: AiCrawlerKind;
};

export const AI_CRAWLERS: AiCrawlerDef[] = [
  { token: "OAI-SearchBot", match: "oai-searchbot", operator: "OpenAI", kind: "index" },
  { token: "ChatGPT-User", match: "chatgpt-user", operator: "OpenAI", kind: "fetch" },
  { token: "GPTBot", match: "gptbot", operator: "OpenAI", kind: "train" },
  { token: "Claude-SearchBot", match: "claude-searchbot", operator: "Anthropic", kind: "index" },
  { token: "Claude-User", match: "claude-user", operator: "Anthropic", kind: "fetch" },
  { token: "ClaudeBot", match: "claudebot", operator: "Anthropic", kind: "train" },
  { token: "PerplexityBot", match: "perplexitybot", operator: "Perplexity", kind: "index" },
  { token: "Perplexity-User", match: "perplexity-user", operator: "Perplexity", kind: "fetch" },
  { token: "Google-Extended", match: null, operator: "Google", kind: "train" },
  { token: "Applebot-Extended", match: null, operator: "Apple", kind: "train" },
  { token: "Applebot", match: "applebot", operator: "Apple", kind: "index" },
  { token: "DuckAssistBot", match: "duckassistbot", operator: "DuckDuckGo", kind: "index" },
  { token: "MistralAI-User", match: "mistralai-user", operator: "Mistral", kind: "fetch" },
  { token: "Amazonbot", match: "amazonbot", operator: "Amazon", kind: "index" },
  { token: "meta-externalagent", match: "meta-externalagent", operator: "Meta", kind: "train" },
  { token: "CCBot", match: "ccbot", operator: "Common Crawl", kind: "train" }
];

/** robots.txt `User-agent:` tokens, in registry order. */
export const AI_CRAWLER_TOKENS: string[] = AI_CRAWLERS.map((c) => c.token);

/**
 * Operators we could ever OBSERVE, i.e. those with at least one entry that
 * identifies itself in a User-Agent header.
 *
 * The distinction matters for "who have we not heard from": an operator whose
 * only entry is a robots.txt opt-out control (Google, whose sole entry is
 * `Google-Extended`) can never show up in traffic, so listing it as missing
 * would report a blocked crawler that was never going to appear.
 */
export const OBSERVABLE_AI_OPERATORS: string[] = [
  ...new Set(AI_CRAWLERS.filter((c) => c.match !== null).map((c) => c.operator))
].sort();

/**
 * Identify an AI agent from a User-Agent header. `Applebot-Extended` is
 * checked before `Applebot` in the registry order above, but neither ever
 * matches a header, so ordering only matters for readability there.
 */
export function matchAiCrawler(userAgent: string | null | undefined): AiCrawlerDef | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  return AI_CRAWLERS.find((c) => c.match !== null && ua.includes(c.match)) ?? null;
}

export type AiReferrerDef = {
  /** Registrable host; subdomains match too. */
  host: string;
  surface: string;
};

/** AI answer surfaces that link out to us, seen as a Referer on human visits. */
export const AI_REFERRERS: AiReferrerDef[] = [
  { host: "chatgpt.com", surface: "ChatGPT" },
  { host: "chat.openai.com", surface: "ChatGPT" },
  { host: "perplexity.ai", surface: "Perplexity" },
  { host: "claude.ai", surface: "Claude" },
  { host: "copilot.microsoft.com", surface: "Copilot" },
  { host: "gemini.google.com", surface: "Gemini" },
  { host: "you.com", surface: "You.com" },
  { host: "phind.com", surface: "Phind" }
];

/** Identify the AI surface a visitor arrived from, by Referer URL. */
export function matchAiReferrer(referrer: string | null | undefined): AiReferrerDef | null {
  if (!referrer) return null;
  let hostname: string;
  try {
    hostname = new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
  return (
    AI_REFERRERS.find((r) => hostname === r.host || hostname.endsWith(`.${r.host}`)) ?? null
  );
}
