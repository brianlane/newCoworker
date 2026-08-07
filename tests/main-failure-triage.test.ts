import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Integration tests for .github/scripts/main-failure-triage.sh, the decision
 * behind main-failure-watch.yml: retry a failed push-to-main run again, or
 * wake a human.
 *
 * The rule it replaced was "failed twice on fresh runners, therefore real",
 * which assumes the same cause reproduced. On 2026-08-06 (run 31068979036)
 * two unrelated transient Supabase failures 30 seconds apart were reported as
 * one real bug, and a human ran the attempt 3 that went green. The fixtures
 * below are that incident: same job, same step, byte-identical `##[error]`
 * markers, and only the lines leading up to the error differ.
 *
 * `gh` and `curl` are stubbed so the real script runs against scripted API
 * responses and its email is captured instead of sent.
 */

const SCRIPT = join(__dirname, "..", ".github", "scripts", "main-failure-triage.sh");

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The real attempt-1 failure: an IPv6 route the runner does not have. */
const LOG_IPV6 = [
  "2026-08-06T03:44:36.1Z Finished supabase link.",
  "2026-08-06T03:44:36.1Z ##[warning]could not read the applied ledger; skipping the order heal.",
  "2026-08-06T03:44:36.1Z IPv6 is not supported on your current network: dial tcp [2600:1f16:1cd0:331f:a645:6c5e:ed32:de24]:5432: connect: network is unreachable",
  "2026-08-06T03:44:36.2Z ##[error]Process completed with exit code 1."
].join("\n");

/** The real attempt-2 failure: Supabase's management API returning a 502. */
const LOG_502 = [
  "2026-08-06T03:45:02.1Z Unexpected error retrieving remote project status: error code: 502",
  "2026-08-06T03:45:02.1Z Try rerunning the command with --debug to troubleshoot the error.",
  "2026-08-06T03:45:02.2Z ##[error]Process completed with exit code 1."
].join("\n");

/** Same shape as LOG_IPV6 but a different address, which must still MATCH. */
const LOG_IPV6_OTHER_ADDRESS = LOG_IPV6.replace("2600:1f16:1cd0:331f:a645:6c5e:ed32:de24", "2600:9999:aaaa:bbbb:cccc:dddd:eeee:ffff");

interface Sandbox {
  dir: string;
  bin: string;
}

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "failure-triage-"));
  sandboxes.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);

  // Dispatches on the request path. Unknown paths return empty, which is the
  // "cannot read" case the script must treat as a repeat failure.
  const gh = `#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"rerun-failed-jobs"* ]]; then
  echo "rerun" >> "$STUB_DIR/reruns.txt"
  exit 0
fi
if [[ "$args" =~ attempts/([0-9]+)/jobs ]]; then
  f="$STUB_DIR/attempt-\${BASH_REMATCH[1]}-jobs.json"
  [ -f "$f" ] && cat "$f"
  exit 0
fi
if [[ "$args" =~ actions/jobs/([0-9]+)/logs ]]; then
  f="$STUB_DIR/job-\${BASH_REMATCH[1]}.log"
  [ -f "$f" ] && cat "$f"
  exit 0
fi
if [[ "$args" == *"filter=latest"* ]]; then
  f="$STUB_DIR/latest-jobs.json"
  [ -f "$f" ] && cat "$f"
  exit 0
fi
exit 0
`;
  writeFileSync(join(bin, "gh"), gh);
  chmodSync(join(bin, "gh"), 0o755);

  // Captures the JSON payload rather than sending it.
  const curl = `#!/usr/bin/env bash
prev=""
for a in "$@"; do
  if [ "$prev" = "-d" ]; then printf '%s' "$a" > "$STUB_DIR/email.json"; fi
  prev="$a"
done
exit 0
`;
  writeFileSync(join(bin, "curl"), curl);
  chmodSync(join(bin, "curl"), 0o755);

  return { dir, bin };
}

/** Script one attempt: which job ids failed, and what each of their logs said. */
function scriptAttempt(sb: Sandbox, attempt: number, jobs: Array<{ id: number; log: string }>) {
  writeFileSync(
    join(sb.dir, `attempt-${attempt}-jobs.json`),
    JSON.stringify({ jobs: jobs.map((j) => ({ id: j.id, name: "Vercel Deploy", conclusion: "failure" })) })
  );
  for (const j of jobs) writeFileSync(join(sb.dir, `job-${j.id}.log`), j.log);
}

function scriptLatestJobs(sb: Sandbox, deployConclusion: string) {
  writeFileSync(
    join(sb.dir, "latest-jobs.json"),
    JSON.stringify({ jobs: [{ id: 1, name: "Vercel Deploy", conclusion: deployConclusion }] })
  );
}

function run(sb: Sandbox, attempt: number, env: Record<string, string> = {}) {
  const res = spawnSync("bash", [SCRIPT], {
    cwd: sb.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${sb.bin}:${process.env.PATH}`,
      STUB_DIR: sb.dir,
      RUN_ID: "31068979036",
      RUN_ATTEMPT: String(attempt),
      RUN_URL: "https://github.com/brianlane/newCoworker/actions/runs/31068979036",
      RUN_TITLE: "Answer the sales email instead of announcing it (#1209)",
      REPO: "brianlane/newCoworker",
      RESEND_API_KEY: "test-key",
      // Pinned so an ambient value cannot change what these assert. Setting it
      // to 2 reproduces the old "failed twice, therefore real" rule, under
      // which six of these fail.
      ALERT_AT_ATTEMPT: "3",
      ...env
    }
  });
  const rerunPath = join(sb.dir, "reruns.txt");
  const emailPath = join(sb.dir, "email.json");
  return {
    status: res.status,
    out: res.stdout + res.stderr,
    reruns: existsSync(rerunPath) ? readFileSync(rerunPath, "utf8").trim().split("\n").length : 0,
    email: existsSync(emailPath)
      ? (JSON.parse(readFileSync(emailPath, "utf8")) as { subject: string; text: string })
      : null
  };
}

describe("main-failure-triage.sh", () => {
  it("retries a first failure without emailing anyone", () => {
    const sb = makeSandbox();
    const res = run(sb, 1);
    expect(res.status, res.out).toBe(0);
    expect(res.reruns).toBe(1);
    expect(res.email).toBeNull();
  });

  // The 2026-08-06 case. Same job, same step, identical error markers, and
  // only the lines above them differ. The old rule alerted here and a human
  // ran the attempt that went green.
  it("retries again when attempt 2 failed for a DIFFERENT reason", () => {
    const sb = makeSandbox();
    scriptAttempt(sb, 1, [{ id: 111, log: LOG_IPV6 }]);
    scriptAttempt(sb, 2, [{ id: 222, log: LOG_502 }]);
    const res = run(sb, 2);
    expect(res.status, res.out).toBe(0);
    expect(res.reruns).toBe(1);
    expect(res.email).toBeNull();
    expect(res.out).toContain("DIFFERENT reasons");
  });

  it("emails at attempt 2 when the same failure repeated, with no extra delay", () => {
    const sb = makeSandbox();
    scriptAttempt(sb, 1, [{ id: 111, log: LOG_IPV6 }]);
    scriptAttempt(sb, 2, [{ id: 222, log: LOG_IPV6 }]);
    scriptLatestJobs(sb, "failure");
    const res = run(sb, 2);
    expect(res.status, res.out).toBe(0);
    expect(res.reruns).toBe(0);
    expect(res.email?.text).toContain("Both attempts failed the same way");
    expect(res.email?.subject).toContain("production did not update");
  });

  // Run-specific values inside one repeating failure must not read as new.
  it("treats the same failure with a different IP address as a repeat", () => {
    const sb = makeSandbox();
    scriptAttempt(sb, 1, [{ id: 111, log: LOG_IPV6 }]);
    scriptAttempt(sb, 2, [{ id: 222, log: LOG_IPV6_OTHER_ADDRESS }]);
    scriptLatestJobs(sb, "failure");
    const res = run(sb, 2);
    expect(res.reruns).toBe(0);
    expect(res.email?.text).toContain("Both attempts failed the same way");
  });

  it("stops retrying at attempt 3 even when the causes keep differing", () => {
    const sb = makeSandbox();
    scriptAttempt(sb, 2, [{ id: 222, log: LOG_502 }]);
    scriptAttempt(sb, 3, [{ id: 333, log: LOG_IPV6 }]);
    scriptLatestJobs(sb, "failure");
    const res = run(sb, 3);
    expect(res.reruns).toBe(0);
    expect(res.email?.text).toContain("attempt 3");
    expect(res.email?.subject).toContain("failed 3 times");
  });

  // Fail safe: an unreadable log must wake a human, never loop forever.
  it("alerts rather than retrying when a signature cannot be read", () => {
    const sb = makeSandbox();
    scriptAttempt(sb, 1, [{ id: 111, log: LOG_IPV6 }]);
    // attempt 2 is left unscripted, so its signature comes back empty.
    scriptLatestJobs(sb, "failure");
    const res = run(sb, 2);
    expect(res.reruns).toBe(0);
    expect(res.email?.text).toContain("could not be compared");
  });

  it("says production IS updated when the deploy job itself succeeded", () => {
    const sb = makeSandbox();
    scriptAttempt(sb, 1, [{ id: 111, log: LOG_IPV6 }]);
    scriptAttempt(sb, 2, [{ id: 222, log: LOG_IPV6 }]);
    scriptLatestJobs(sb, "success");
    const res = run(sb, 2);
    expect(res.email?.subject).toContain("after deploy");
    expect(res.email?.text).toContain("production IS updated");
  });

  it("never claims a runner blip was ruled out", () => {
    const sb = makeSandbox();
    scriptAttempt(sb, 1, [{ id: 111, log: LOG_IPV6 }]);
    scriptAttempt(sb, 2, [{ id: 222, log: LOG_IPV6 }]);
    scriptLatestJobs(sb, "failure");
    const res = run(sb, 2);
    expect(res.email?.text).not.toContain("not a runner blip");
  });

  // The group header ahead of a failing step echoes the whole env block, and
  // those lines vary between attempts on their own. If they reach the
  // comparison, it measures runner noise instead of the failure.
  it("ignores the echoed env block when comparing two identical failures", () => {
    const sb = makeSandbox();
    const envBlock = (nodeVersion: string) =>
      [
        "2026-08-06T03:44:36.0Z ##[group]Run bash .github/scripts/supabase-deploy.sh deploy",
        "2026-08-06T03:44:36.0Z env:",
        `2026-08-06T03:44:36.0Z   NODE_VERSION: ${nodeVersion}`,
        "2026-08-06T03:44:36.0Z   SUPABASE_ACCESS_TOKEN: ***",
        "2026-08-06T03:44:36.0Z   shell: /usr/bin/bash -e {0}",
        "2026-08-06T03:44:36.0Z ##[endgroup]"
      ].join("\n");
    scriptAttempt(sb, 1, [{ id: 111, log: `${envBlock("24")}\n${LOG_IPV6}` }]);
    scriptAttempt(sb, 2, [{ id: 222, log: `${envBlock("22")}\n${LOG_IPV6}` }]);
    scriptLatestJobs(sb, "failure");
    const res = run(sb, 2);
    expect(res.reruns, res.out).toBe(0);
    expect(res.email?.text).toContain("Both attempts failed the same way");
  });

  // ERROR: is how the coverage gate speaks. It must survive the env filter,
  // or two unrelated coverage failures collapse into one signature.
  it("keeps a shouted real message such as the coverage gate", () => {
    const sb = makeSandbox();
    const cov = (pct: string) =>
      [
        "2026-08-06T03:44:36.0Z   NODE_VERSION: 24",
        `2026-08-06T03:44:36.0Z ERROR: Coverage for branches (${pct}%) does not meet global threshold (100%)`,
        "2026-08-06T03:44:36.2Z ##[error]Process completed with exit code 1."
      ].join("\n");
    scriptAttempt(sb, 1, [{ id: 111, log: cov("99.99") }]);
    scriptAttempt(sb, 2, [{ id: 222, log: LOG_502 }]);
    const res = run(sb, 2);
    // Different failures, so it retries, and the coverage line is what proves
    // the ERROR: line reached the comparison at all.
    expect(res.reruns, res.out).toBe(1);
    expect(res.out).toContain("Coverage for branches");
  });

  it("warns instead of crashing when RESEND_API_KEY is missing", () => {
    const sb = makeSandbox();
    scriptAttempt(sb, 1, [{ id: 111, log: LOG_IPV6 }]);
    scriptAttempt(sb, 2, [{ id: 222, log: LOG_IPV6 }]);
    const res = run(sb, 2, { RESEND_API_KEY: "" });
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("RESEND_API_KEY secret is not set");
    expect(res.email).toBeNull();
  });
});
