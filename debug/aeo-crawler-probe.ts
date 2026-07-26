/**
 * Can the AI assistants actually read newcoworker.com?
 *
 * Fetches the marketing surfaces that matter for AI answers once per AI user
 * agent and reports the status. Everything else in the AEO work is pointless
 * if the edge is challenging these agents, and the failure is invisible from
 * the app: Cloudflare's Super Bot Fight Mode / "Block AI bots" settings serve
 * a 403 or a managed challenge with ZERO origin trace (the same class of
 * failure documented for the Claude MCP connector in the README).
 *
 * Read-only: plain GETs against the public site, no credentials, no writes.
 *
 * Usage:
 *   tsx debug/aeo-crawler-probe.ts                       # production
 *   tsx debug/aeo-crawler-probe.ts https://staging.host  # another origin
 */
import { AI_CRAWLERS } from "../src/lib/marketing/ai-crawlers.ts";

const BASE_URL = (process.argv[2] ?? "https://newcoworker.com").replace(/\/$/, "");

const PATHS = ["/", "/pricing", "/features", "/faq", "/robots.txt", "/llms.txt", "/sitemap.xml"];

/**
 * Realistic full User-Agent strings. A bare token ("GPTBot") is not what the
 * bots send, and edge bot-detection scores the whole string, so probing with
 * the token alone can pass where the real agent is blocked.
 */
const UA_TEMPLATES: Record<string, string> = {
  "OAI-SearchBot": "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
  "ChatGPT-User": "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)",
  GPTBot: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  "Claude-SearchBot": "Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +claudebot@anthropic.com)",
  "Claude-User": "Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
  ClaudeBot: "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  PerplexityBot: "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  "Perplexity-User": "Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
  Applebot: "Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)",
  DuckAssistBot: "Mozilla/5.0 (compatible; DuckAssistBot/1.0; +https://duckduckgo.com/duckassistbot)",
  "MistralAI-User": "Mozilla/5.0 (compatible; MistralAI-User/1.0; +https://mistral.ai/bot)",
  Amazonbot: "Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/amazonbot)",
  "meta-externalagent": "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  CCBot: "CCBot/2.0 (https://commoncrawl.org/faq/)"
};

const TIMEOUT_MS = 20_000;

async function probe(userAgent: string, path: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { "user-agent": userAgent, accept: "*/*" },
      redirect: "follow",
      signal: controller.signal
    });
    // A challenge page answers 200 with an interstitial body, so status alone
    // can read as healthy. Cloudflare stamps its own responses with cf-mitigated.
    const mitigated = res.headers.get("cf-mitigated");
    if (mitigated) return `${res.status}!${mitigated}`;
    return String(res.status);
  } catch (err) {
    return err instanceof Error && err.name === "AbortError" ? "timeout" : "error";
  } finally {
    clearTimeout(timer);
  }
}

console.log(`AI crawler access probe: ${BASE_URL}\n`);

const header = ["agent".padEnd(20), ...PATHS.map((p) => p.padStart(13))].join("");
console.log(header);
console.log("-".repeat(header.length));

let blocked = 0;
for (const crawler of AI_CRAWLERS) {
  const ua = UA_TEMPLATES[crawler.token];
  // Google-Extended / Applebot-Extended are robots.txt opt-out controls that
  // never issue a request, so there is nothing to probe.
  if (!ua) continue;

  const results: string[] = [];
  for (const path of PATHS) {
    const status = await probe(ua, path);
    if (status !== "200") blocked += 1;
    results.push(status.padStart(13));
  }
  console.log(`${crawler.token.padEnd(20)}${results.join("")}`);
}

console.log();
if (blocked > 0) {
  console.log(
    `FAIL: ${blocked} non-200 response(s). Check Cloudflare Security -> Events for the\n` +
      `newcoworker.com zone: Super Bot Fight Mode and the "Block AI bots" setting both\n` +
      `challenge these agents, and free-plan Bot Fight Mode ignores WAF skip rules.`
  );
  process.exit(1);
}
console.log("OK: every AI agent got 200 on every probed path.");
