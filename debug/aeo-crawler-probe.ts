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
import { AI_CRAWLERS, ZONE_DISALLOWED_AI_TOKENS } from "../src/lib/marketing/ai-crawlers.ts";

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

  // Does the file we are looking at contain OUR robots.txt at all? Cloudflare
  // can either PREPEND its managed block to the origin's file or REPLACE it
  // outright, and the two look similar until you check for our own markers.
  // Replacement is the dangerous case: it silently drops the /dashboard,
  // /admin, and /api disallows and the Sitemap line.
  const oursPresent = robotsText.includes("Disallow: /dashboard");
  if (!oursPresent) {
    policyProblem = true;
    console.log(
      "ORIGIN robots.txt IS NOT BEING SERVED on this host: Cloudflare has REPLACED it\n" +
        "rather than prepending to it. src/app/robots.ts never reaches a crawler here, so\n" +
        "/dashboard, /admin, and /api are not disallowed and the Sitemap line is missing.\n" +
        "Fix in the Cloudflare dashboard (AI Crawl Control / managed robots.txt) so the\n" +
        "managed block APPENDS to the origin file instead of replacing it.\n"
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
    console.log(
      "NOTE: Cloudflare is PREPENDING a managed block to this robots.txt. Its default AI\n" +
        "policy (search=yes, ai-train=no) disallows the training crawlers, which is a\n" +
        "deliberate posture, not necessarily a defect. Decide it on purpose:\n" +
        "Cloudflare dashboard -> the zone -> AI Crawl Control / robots.txt.\n"
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

  // ZONE_DISALLOWED_AI_TOKENS is an observed fact about Cloudflare's managed
  // list, and facts drift. Cross-check it against what is actually served so
  // the next change there surfaces here instead of as a fresh conflict.
  const servedDenied = new Set([...denied, ...conflicting].map((r) => r.token));
  const staleEntries = ZONE_DISALLOWED_AI_TOKENS.filter((t) => !servedDenied.has(t));
  const unrecorded = [...servedDenied].filter((t) => !ZONE_DISALLOWED_AI_TOKENS.includes(t));
  if (oursPresent && (staleEntries.length > 0 || unrecorded.length > 0)) {
    policyProblem = true;
    console.log(
      "ZONE_DISALLOWED_AI_TOKENS is out of date with the served file:\n" +
        (unrecorded.length > 0 ? `  newly disallowed, add: ${unrecorded.join(", ")}\n` : "") +
        (staleEntries.length > 0 ? `  no longer disallowed, drop: ${staleEntries.join(", ")}\n` : "") +
        "Update src/lib/marketing/ai-crawlers.ts so robots.txt keeps agreeing with the zone.\n"
    );
  }
}

if (blocked > 0 || policyProblem) process.exit(1);
console.log("OK: transport and robots.txt policy both clear.");
