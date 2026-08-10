/**
 * Does the production site still support what the CASA SAQ claims?
 *
 * The 2026 ADA-CASA AL1 assessment answered 54 questions about how this
 * application behaves. Most of those answers are only observable from outside,
 * which is the same class of claim `debug/aeo-crawler-probe.ts` exists to
 * verify, per the standing rule in the README: unit tests assert what we
 * INTEND to serve, a probe asserts what is ACTUALLY served.
 *
 * Run this before the annual reassessment, and after any change to the CDN
 * zone, the hosting configuration, or the auth settings. The output is a dated
 * report suitable for attaching to the reassessment packet.
 *
 * The single most important check here is CORS, and it is important for a
 * non-obvious reason. Vercel's static serving replaces our
 * `Access-Control-Allow-Origin` with `*` ONLY when the request carries an
 * `Origin` header. A plain curl shows the correct value and looks fixed. In
 * 2026 that cost two extra pull requests and a wasted cache purge before the
 * cause was found, so every request below sends an Origin.
 *
 * Read-only: plain GETs against the public site plus one deliberately invalid
 * signup attempt that cannot create an account (a 5-character password is
 * below Supabase's own floor of 6, so it is rejected under every possible
 * configuration).
 *
 * Usage:
 *   tsx debug/casa-posture-probe.ts                       # production
 *   tsx debug/casa-posture-probe.ts https://staging.host  # another origin
 */
import {
  BASELINE_HEADERS,
  DISCLOSURE_PATHS,
  checkBaselineHeaders,
  checkCorsHeader,
  checkDisclosurePath,
  checkHsts,
  checkPasswordMinimum,
  checkSecurityTxt,
  formatReport,
  summarize,
  type CheckResult
} from "../src/lib/casa/posture-checks.ts";

const BASE_URL = (process.argv[2] ?? "https://www.newcoworker.com").replace(/\/$/, "");
const TIMEOUT_MS = 25_000;

/** Any origin that is not ours; its only job is to make the request CORS-y. */
const FOREIGN_ORIGIN = "https://casa-probe.invalid";

/** Public surfaces a scanner would crawl and check for a wildcard. */
const CORS_PATHS = [
  "/",
  "/robots.txt",
  "/llms.txt",
  "/llms-full.txt",
  "/sitemap.xml",
  "/logo.png",
  "/favicon.ico",
  "/.well-known/security.txt"
];

async function get(path: string): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${BASE_URL}${path}`, {
      headers: { Origin: FOREIGN_ORIGIN },
      redirect: "manual",
      signal: controller.signal
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `Headers.get` joins repeats with ", ". Split them back out so a duplicated
 * Access-Control-Allow-Origin is visible rather than silently concatenated,
 * because two of those is its own misconfiguration.
 */
function allValues(res: Response, name: string): string[] {
  const raw = res.headers.get(name);
  if (!raw) return [];
  return raw.split(",").map((v) => v.trim()).filter(Boolean);
}

const results: CheckResult[] = [];

// --- CORS, the one that must send an Origin header ---
for (const path of CORS_PATHS) {
  const res = await get(path);
  if (!res) {
    results.push({
      id: `cors:${path}`,
      label: `CORS on ${path}`,
      ok: false,
      detail: "request failed",
      saq: "4, 18"
    });
    continue;
  }
  results.push(checkCorsHeader(path, allValues(res, "access-control-allow-origin")));
}

// --- Transport and baseline headers, read from the site root ---
const root = await get("/");
if (root) {
  results.push(checkHsts(root.headers.get("strict-transport-security")));
  results.push(...checkBaselineHeaders((name) => root.headers.get(name)));
} else {
  results.push({
    id: "hsts",
    label: "HSTS",
    ok: false,
    detail: "root request failed",
    saq: "53"
  });
  for (const name of BASELINE_HEADERS) {
    results.push({
      id: `header:${name}`,
      label: name,
      ok: false,
      detail: "root request failed",
      saq: "17, 18"
    });
  }
}

// --- Nothing source-shaped is readable ---
for (const path of DISCLOSURE_PATHS) {
  const res = await get(path);
  results.push(checkDisclosurePath(path, res ? res.status : 0));
}

// A served source map would disclose original sources just as effectively as
// a readable repository file, so derive one from the live markup.
const html = root ? await root.clone().text().catch(() => "") : "";
const chunk = /\/_next\/static\/chunks\/[A-Za-z0-9_.-]+\.js/.exec(html)?.[0];
if (chunk) {
  const res = await get(`${chunk}.map`);
  results.push(checkDisclosurePath(`${chunk}.map`, res ? res.status : 0));
}

// --- security.txt, including a non-expired Expires ---
const securityTxt = await get("/.well-known/security.txt");
results.push(
  securityTxt && securityTxt.ok
    ? checkSecurityTxt(await securityTxt.text(), new Date())
    : {
        id: "security-txt",
        label: "security.txt",
        ok: false,
        detail: securityTxt ? `HTTP ${securityTxt.status}` : "request failed",
        saq: "policy"
      }
);

// --- The live password minimum, read from the auth provider's own rejection ---
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (supabaseUrl && anonKey) {
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      // Five characters: below Supabase's own floor of 6, so this is rejected
      // under every possible configuration and can never create an account.
      body: JSON.stringify({ email: "casa-posture-probe@example.com", password: "aA1!x" })
    });
    const body = (await res.json()) as { msg?: string };
    results.push(checkPasswordMinimum(body.msg, 12));
  } catch {
    results.push({
      id: "password-minimum",
      label: "password minimum",
      ok: false,
      detail: "probe request failed",
      saq: "19"
    });
  }
} else {
  results.push({
    id: "password-minimum",
    label: "password minimum",
    ok: false,
    detail: "skipped: NEXT_PUBLIC_SUPABASE_URL / ANON_KEY not in env",
    saq: "19"
  });
}

console.log(`CASA posture probe: ${BASE_URL}`);
console.log(`Run at: ${new Date().toISOString()}\n`);
console.log(formatReport(results));

const summary = summarize(results);
console.log(`\n${summary.passed}/${summary.total} checks passed.`);

if (!summary.ok) {
  console.log(
    "\nFailures above are claims the SAQ makes that production no longer supports.\n" +
      "Fix them before the reassessment rather than restating the old answer.\n" +
      "TLS minimum version and certificate chain are not covered here; check those\n" +
      "with Qualys SSL Labs, whose report is the artifact the assessor expects."
  );
  process.exit(1);
}

console.log(
  "\nEvery externally observable SAQ claim still holds.\n" +
    "Attach this output, plus a current SSL Labs report, to the reassessment."
);
