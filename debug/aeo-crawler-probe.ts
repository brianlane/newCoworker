/**
 * Can the AI assistants actually read newcoworker.com?
 *
 * Two independent ways to be shut out, so this checks both:
 *
 *   1. TRANSPORT. The edge refuses the request. Cloudflare's Super Bot Fight
 *      Mode / "Block AI bots" settings serve a 403 or a managed challenge
 *      with ZERO origin trace (the same class of failure documented for the
 *      Claude MCP connector in the README). Caught by fetching the marketing
 *      surfaces once per real AI user-agent string.
 *
 *   2. POLICY. The transport is fine and robots.txt tells the agent to go
 *      away. A well-behaved crawler then never requests anything, so every
 *      status code here is 200 and nothing looks wrong. Cloudflare PREPENDS
 *      a managed block to the origin's robots.txt (its default AI policy is
 *      `search=yes, ai-train=no`, which disallows the training crawlers:
 *      GPTBot, ClaudeBot, CCBot, Amazonbot, Google-Extended,
 *      Applebot-Extended, meta-externalagent). That block sits ABOVE the
 *      group src/app/robots.ts emits, so the served file can contain two
 *      contradicting groups for one token, and which one wins is up to each
 *      crawler's parser.
 *
 * Read-only: plain GETs against the public site, no credentials, no writes.
 *
 * Usage:
 *   tsx debug/aeo-crawler-probe.ts                       # production
 *   tsx debug/aeo-crawler-probe.ts https://staging.host  # another origin
 */
import {
  AI_ANSWER_CRAWLER_TOKENS,
  AI_CRAWLERS,
  AI_TRAINING_CRAWLER_TOKENS
} from "../src/lib/marketing/ai-crawlers.ts";

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

/** What robots.txt says about `/` for one user-agent token. */
type RobotsRuling = "allowed" | "disallowed" | "conflicting" | "unmentioned";

/**
 * Parse robots.txt into groups. Consecutive `User-agent:` lines share the
 * rules that follow, which is how both our own file and Cloudflare's managed
 * block are written.
 */
function parseRobots(text: string): Array<{ agents: string[]; allowRoot: boolean | null }> {
  const groups: Array<{ agents: string[]; allowRoot: boolean | null }> = [];
  let current: { agents: string[]; allowRoot: boolean | null } | null = null;
  let collectingAgents = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const [rawField, ...rest] = line.split(":");
    const field = rawField.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (field === "user-agent") {
      if (!collectingAgents || current === null) {
        current = { agents: [], allowRoot: null };
        groups.push(current);
        collectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (current === null) continue;
    collectingAgents = false;

    // Only root-scoped rules decide "can this agent read the site at all".
    if (field === "disallow" && value === "/") current.allowRoot = false;
    if (field === "allow" && value === "/" && current.allowRoot === null) current.allowRoot = true;
  }
  return groups;
}

function rulingFor(
  groups: ReturnType<typeof parseRobots>,
  token: string
): RobotsRuling {
  const matched = groups
    .filter((g) => g.agents.includes(token.toLowerCase()))
    .map((g) => g.allowRoot)
    .filter((v): v is boolean => v !== null);
  if (matched.length === 0) return "unmentioned";
  if (matched.every((v) => v)) return "allowed";
  if (matched.every((v) => !v)) return "disallowed";
  return "conflicting";
}

async function fetchRobots(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE_URL}/robots.txt`, { redirect: "follow" });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
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
    `TRANSPORT FAIL: ${blocked} non-200 response(s). Check Cloudflare Security -> Events\n` +
      `for the zone: Super Bot Fight Mode and the "Block AI bots" setting both challenge\n` +
      `these agents, and free-plan Bot Fight Mode ignores WAF skip rules.\n`
  );
} else {
  console.log("Transport OK: every AI agent got 200 on every probed path.\n");
}

// --- robots.txt policy -----------------------------------------------------
const robotsText = await fetchRobots();
let policyProblem = false;

if (robotsText === null) {
  console.log("POLICY UNKNOWN: could not read /robots.txt.");
  policyProblem = true;
} else {
  const groups = parseRobots(robotsText);
  const managed = robotsText.includes("Cloudflare Managed content");

  // Is the file we are looking at OURS? Cloudflare's "Managed robots.txt"
  // CREATES a file where the origin serves none, which is how the apex ended
  // up with a standalone block carrying none of our rules.
  const oursPresent = robotsText.includes("src/lib/marketing/robots-txt.ts");
  if (!oursPresent) {
    policyProblem = true;
    console.log(
      "OUR robots.txt IS NOT BEING SERVED on this host. Something upstream is generating\n" +
        "it instead, so /dashboard, /admin, and /api may not be disallowed and the Sitemap\n" +
        "line may be missing. Check Cloudflare -> AI Crawl Control -> Signals ->\n" +
        "Managed robots.txt; it must stay OFF now that the policy lives in our code.\n"
    );
  }
  if (!robotsText.includes("Sitemap:")) {
    policyProblem = true;
    console.log("No Sitemap: line in this robots.txt. Crawlers lose the cheapest route in.\n");
  }
  const rulings = AI_CRAWLERS.map((c) => ({ token: c.token, kind: c.kind, ruling: rulingFor(groups, c.token) }));
  const denied = rulings.filter((r) => r.ruling === "disallowed");
  const conflicting = rulings.filter((r) => r.ruling === "conflicting");

  console.log("robots.txt ruling for / (transport says nothing about this):");
  for (const r of rulings) {
    const mark = r.ruling === "allowed" ? " " : r.ruling === "unmentioned" ? "?" : "!";
    console.log(`  ${mark} ${r.token.padEnd(20)} ${r.kind.padEnd(6)} ${r.ruling}`);
  }
  console.log();

  if (managed) {
    policyProblem = true;
    const verb = oursPresent
      ? "is PREPENDING a managed block to our robots.txt"
      : "has REPLACED our robots.txt with its managed block";
    console.log(
      `Cloudflare ${verb}. That feature was turned OFF deliberately\n` +
        "(it creates a file where the origin serves none, which left the apex without our\n" +
        "Disallow rules or Sitemap line). If it is back on, turn it off again:\n" +
        "Cloudflare -> the zone -> AI Crawl Control -> Signals -> Managed robots.txt.\n"
    );
  }
  if (conflicting.length > 0) {
    policyProblem = true;
    console.log(
      `POLICY CONFLICT: ${conflicting.map((r) => r.token).join(", ")} appear in BOTH an\n` +
        "allow and a disallow group. Which one wins is up to each crawler's parser, so\n" +
        "this is undefined behavior either way. Make the two sources agree.\n"
    );
  }
  if (denied.length > 0) {
    console.log(
      `Disallowed outright: ${denied.map((r) => r.token).join(", ")}.\n` +
        "A well-behaved agent here simply never requests anything, so it costs no HTTP\n" +
        "errors and shows up only as silence on /admin/ai-search.\n"
    );
  }

  // The served file must match what our code intends, token for token.
  const servedDenied = new Set([...denied, ...conflicting].map((r) => r.token));
  const shouldDeny = new Set(AI_TRAINING_CRAWLER_TOKENS);
  const missingDeny = [...shouldDeny].filter((t) => !servedDenied.has(t));
  const unexpectedDeny = [...servedDenied].filter((t) => !shouldDeny.has(t));
  const notAllowed = AI_ANSWER_CRAWLER_TOKENS.filter(
    (t) => rulings.find((r) => r.token === t)?.ruling !== "allowed"
  );
  if (oursPresent && (missingDeny.length > 0 || unexpectedDeny.length > 0 || notAllowed.length > 0)) {
    policyProblem = true;
    console.log(
      "SERVED FILE DOES NOT MATCH src/lib/marketing/robots-txt.ts:\n" +
        (missingDeny.length > 0 ? `  should be disallowed but is not: ${missingDeny.join(", ")}\n` : "") +
        (unexpectedDeny.length > 0 ? `  disallowed but should not be: ${unexpectedDeny.join(", ")}\n` : "") +
        (notAllowed.length > 0 ? `  should be explicitly allowed but is not: ${notAllowed.join(", ")}\n` : "") +
        "Either the deploy has not landed or something upstream is rewriting the file.\n"
    );
  }
}

if (blocked > 0 || policyProblem) process.exit(1);
console.log("OK: transport and robots.txt policy both clear.");
