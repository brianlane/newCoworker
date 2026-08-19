/**
 * indexnow-submit.ts, tell the search engines what just changed.
 *
 * Two callers:
 *   - CI, after a production deploy, via the `indexnow-ping` job in ci.yml.
 *   - A human, on demand, when something important just shipped and waiting
 *     for the next crawl is not good enough.
 *
 * Read-only against our own public surfaces plus one POST to
 * api.indexnow.org. No credentials: the IndexNow key is PUBLIC by protocol
 * design (we serve it at /indexnow-key.txt so the engines can verify
 * ownership), so this fetches it from the live site rather than requiring a
 * copy in GitHub secrets. Unset there means the feature is off and this
 * no-ops.
 *
 * ALWAYS EXITS 0. A search-engine notification must never read as a failed
 * deploy: main-failure-watch.yml emails "production did not update" on a red
 * CI run, and paging a human because IndexNow returned 429 would be a false
 * alarm. Problems are printed as a FAIL line and summarized for the job log.
 *
 * Usage:
 *   tsx scripts/indexnow-submit.ts --all
 *   tsx scripts/indexnow-submit.ts --changed <path> [<path> ...]
 *   tsx scripts/indexnow-submit.ts --changed --stdin   # newline-separated
 *   tsx scripts/indexnow-submit.ts --all --origin https://staging.example
 *   tsx scripts/indexnow-submit.ts --all --dry-run
 */
import { appendFileSync } from "node:fs";
import { submitToIndexNow, KEY_FILE_PATH } from "../src/lib/marketing/indexnow.ts";
import { deployTouchesPublicPages, deployUrlSet } from "../src/lib/marketing/indexnow-deploy.ts";
import { SITE_URL } from "../src/lib/marketing/site-url.ts";

const args = process.argv.slice(2);

function flagValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const ORIGIN = (flagValue("--origin") ?? SITE_URL).replace(/\/$/, "");
const DRY_RUN = args.includes("--dry-run");
const CHANGED_MODE = args.includes("--changed");

/** One line for the human AND for the CI job summary, so neither is silent. */
function report(line: string): void {
  console.log(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, `${line}\n`);
    } catch {
      /* summary is a convenience; never let it matter */
    }
  }
}

function done(line: string): never {
  report(line);
  process.exit(0);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Changed paths from the command line, or from stdin with --stdin. */
async function changedPaths(): Promise<string[]> {
  if (args.includes("--stdin")) {
    return (await readStdin()).split("\n").filter((l) => l.trim() !== "");
  }
  // Everything after --changed that is not another flag or a flag's value.
  const start = args.indexOf("--changed") + 1;
  const originValue = flagValue("--origin");
  return args
    .slice(start)
    .filter((a) => !a.startsWith("--") && a !== originValue);
}

async function fetchText(url: string, attempts = 3): Promise<string | null> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
      if (res.ok) return await res.text();
      // 404 on the key file is a real answer (feature off), not a blip.
      if (res.status === 404) return null;
    } catch {
      /* fall through to the retry */
    }
    // The deploy was promoted seconds ago; give the edge a moment to catch up.
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  return null;
}

async function main(): Promise<void> {
  if (!CHANGED_MODE && !args.includes("--all")) {
    done("FAIL: pass --all or --changed. See the header of this file.");
  }

  if (CHANGED_MODE) {
    const paths = await changedPaths();
    // FAIL CLOSED. An empty list means we could not learn what changed, and
    // announcing every URL on every backend-only deploy is exactly the
    // behavior the protocol asks us not to have. Skipping costs a few days
    // of latency at worst: the weekly auto-post re-submits the sitemap.
    if (paths.length === 0) {
      done("IndexNow: no changed-file list available, skipping (fail closed).");
    }
    if (!deployTouchesPublicPages(paths)) {
      done(`IndexNow: none of ${paths.length} changed file(s) can affect a public page, skipping.`);
    }
  }

  const key = (process.env.INDEXNOW_KEY ?? "").trim() || (await fetchText(`${ORIGIN}${KEY_FILE_PATH}`))?.trim();
  if (!key) {
    done(`IndexNow: no key (env unset and ${ORIGIN}${KEY_FILE_PATH} unreadable), skipping.`);
  }

  const sitemapXml = await fetchText(`${ORIGIN}/sitemap.xml`);
  if (sitemapXml === null) {
    done(`FAIL: could not read ${ORIGIN}/sitemap.xml after retries, nothing submitted.`);
  }

  const urls = deployUrlSet(sitemapXml, ORIGIN);
  if (urls.length === 0) {
    done(`FAIL: ${ORIGIN}/sitemap.xml yielded no URLs, nothing submitted.`);
  }

  if (DRY_RUN) {
    console.log(urls.join("\n"));
    done(`IndexNow (dry run): would submit ${urls.length} URL(s) for ${ORIGIN}.`);
  }

  const outcome = await submitToIndexNow(urls, { key });
  if (outcome.status === "sent") {
    done(`IndexNow: submitted ${outcome.submitted} URL(s) for ${ORIGIN} (HTTP ${outcome.httpStatus}).`);
  }
  done(`FAIL: IndexNow submission did not send (${JSON.stringify(outcome)}).`);
}

// `done()` exits, so main only rejects on something genuinely unexpected,
// which still must not fail the job.
main().catch((err) => {
  report(`FAIL: IndexNow submit threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
});
