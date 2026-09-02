import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Integration tests for .github/scripts/cursor-automerge.sh, the Cloud Agent
 * sibling of dependabot-automerge.yml. Cloud Agent PRs are opened as the
 * human who started the run, on a cursor/ branch, so the Dependabot author
 * + label gate cannot see them. This script squash-merges only when the
 * repo merge policy is satisfied, including the two extras the GitHub
 * ruleset does not require: Cursor Bugbot SUCCESS, and mergeStateStatus
 * CLEAN on two consecutive reads.
 *
 * `gh` is stubbed so the real bash runs against scripted API responses.
 */

const SCRIPT = join(__dirname, "..", ".github", "scripts", "cursor-automerge.sh");
const E2E_GATE = join(__dirname, "..", ".github", "scripts", "e2e-gate.sh");
const WORKFLOW = join(__dirname, "..", ".github", "workflows", "cursor-automerge.yml");
const DEPENDABOT_WORKFLOW = join(__dirname, "..", ".github", "workflows", "dependabot-automerge.yml");
const DEV_WORKFLOW = join(__dirname, "..", ".cursor/rules/dev-workflow.mdc");
const MERGE_POLICY = join(__dirname, "..", ".cursor/rules/pr-merge-policy.mdc");

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPO = "owner/repo";

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  dir: string;
  bin: string;
}

interface PrView {
  headRefOid?: string;
  headRefName?: string;
  state?: string;
  isDraft?: boolean;
  mergeStateStatus?: string;
  isCrossRepository?: boolean;
}

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "cursor-automerge-"));
  sandboxes.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);

  // Dispatches on the gh subcommand. --jq is applied with real jq so the
  // script sees the same filtered stdout it would from the GitHub CLI.
  const gh = `#!/usr/bin/env bash
set -euo pipefail
{
  printf '%s' "$1"
  for a in "\${@:2}"; do printf '\\t%s' "$a"; done
  printf '\\n'
} >> "$STUB_DIR/gh.log"

jq_filter=""
next_is_jq=0
head_branch=""
next_is_head=0
endpoint=""
for a in "$@"; do
  if [ "$next_is_jq" = 1 ]; then jq_filter="$a"; next_is_jq=0; continue; fi
  if [ "$next_is_head" = 1 ]; then head_branch="$a"; next_is_head=0; continue; fi
  case "$a" in
    --jq) next_is_jq=1 ;;
    --head) next_is_head=1 ;;
    graphql) endpoint="graphql" ;;
    repos/*) endpoint="$a" ;;
  esac
done

apply_jq() {
  local raw="$1"
  if [ -n "$jq_filter" ]; then
    jq -r "$jq_filter" <<<"$raw"
  else
    printf '%s' "$raw"
  fi
}

if [ "\${1:-}" = "workflow" ] && [ "\${2:-}" = "run" ]; then
  printf '%s\\n' "$*" >> "$STUB_DIR/workflow-runs.txt"
  exit 0
fi

if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "merge" ]; then
  n=\$(cat "$STUB_DIR/merge-attempts" 2>/dev/null || echo 0)
  n=\$((n + 1))
  echo "\$n" > "$STUB_DIR/merge-attempts"
  if [ -f "$STUB_DIR/merge-fail-until" ]; then
    until=\$(cat "$STUB_DIR/merge-fail-until")
    if [ "\$n" -le "\$until" ]; then
      echo "GraphQL: Base branch was modified. Review and try the merge again." >&2
      exit 1
    fi
  fi
  if [ -f "$STUB_DIR/merge-error.txt" ]; then
    cat "$STUB_DIR/merge-error.txt" >&2
    exit 1
  fi
  printf '%s\\n' "$*" >> "$STUB_DIR/merges.txt"
  exit 0
fi

if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "view" ]; then
  pr="\${3:-}"
  n=\$(cat "$STUB_DIR/view-count" 2>/dev/null || echo 0)
  n=\$((n + 1))
  echo "\$n" > "$STUB_DIR/view-count"
  f="$STUB_DIR/pr-\${pr}-view-\${n}.json"
  [ -f "\$f" ] || f="$STUB_DIR/pr-\${pr}.json"
  apply_jq "\$(cat "\$f")"
  exit 0
fi

if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "list" ]; then
  if [ -n "\$head_branch" ]; then
    apply_jq "\$(cat "$STUB_DIR/pr-list-head.json")"
  else
    apply_jq "\$(cat "$STUB_DIR/pr-list.json")"
  fi
  exit 0
fi

if [ "\$endpoint" = "graphql" ]; then
  apply_jq "\$(cat "$STUB_DIR/graphql.json")"
  exit 0
fi

if [[ "\$endpoint" == *"/check-runs" ]]; then
  apply_jq "\$(cat "$STUB_DIR/check-runs.json")"
  exit 0
fi

if [[ "\$endpoint" == *"/status" ]]; then
  apply_jq "\$(cat "$STUB_DIR/status.json")"
  exit 0
fi

if [[ "\$endpoint" == *"/pulls" ]]; then
  apply_jq "\$(cat "$STUB_DIR/commit-pulls.json")"
  exit 0
fi

echo "unhandled gh invocation: $*" >&2
exit 1
`;
  writeFileSync(join(bin, "gh"), gh);
  chmodSync(join(bin, "gh"), 0o755);
  return { dir, bin };
}

function writeJson(sb: Sandbox, name: string, value: unknown) {
  writeFileSync(join(sb.dir, name), JSON.stringify(value));
}

function greenChecks(extra: Array<{ name: string; status: string; conclusion: string }> = []) {
  return {
    check_runs: [
      { name: "Tests", status: "completed", conclusion: "success" },
      { name: "Cursor Bugbot", status: "completed", conclusion: "success" },
      { name: "label-dependabot", status: "completed", conclusion: "skipped" },
      { name: "auto-merge", status: "completed", conclusion: "skipped" },
      { name: "cursor-auto-merge", status: "completed", conclusion: "skipped" },
      ...extra
    ]
  };
}

function openCursorPr(overrides: PrView = {}): PrView {
  return {
    headRefOid: SHA,
    headRefName: "cursor/cloud-agent-automerge-a777",
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    isCrossRepository: false,
    ...overrides
  };
}

function seedGreenPr(sb: Sandbox, pr = 1768, view: PrView = {}) {
  writeJson(sb, `pr-${pr}.json`, openCursorPr(view));
  writeJson(sb, "check-runs.json", greenChecks());
  writeJson(sb, "status.json", { state: "success", total_count: 1 });
  writeJson(sb, "graphql.json", {
    data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true }] } } } }
  });
  writeJson(sb, "pr-list-head.json", [{ number: pr }]);
  writeJson(sb, "pr-list.json", [
    { number: pr, headRefName: "cursor/cloud-agent-automerge-a777", isDraft: false }
  ]);
  writeJson(sb, "commit-pulls.json", [
    { state: "open", number: pr, head: { sha: SHA } }
  ]);
}

function run(
  sb: Sandbox,
  env: Record<string, string> = {}
): { status: number | null; out: string; merges: string; log: string; workflows: string } {
  const res = spawnSync("bash", [SCRIPT], {
    cwd: sb.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${sb.bin}:${process.env.PATH}`,
      STUB_DIR: sb.dir,
      GH_TOKEN: "test-token",
      REPO,
      EVENT_NAME: "workflow_run",
      HEAD_SHA: SHA,
      HEAD_BRANCH: "cursor/cloud-agent-automerge-a777",
      POLL_SECONDS: "0",
      MERGE_RETRY_SLEEP: "0",
      ...env
    }
  });
  const mergesPath = join(sb.dir, "merges.txt");
  const logPath = join(sb.dir, "gh.log");
  const workflowsPath = join(sb.dir, "workflow-runs.txt");
  return {
    status: res.status,
    out: `${res.stdout}${res.stderr}`,
    merges: readFileSyncExists(mergesPath),
    log: readFileSyncExists(logPath),
    workflows: readFileSyncExists(workflowsPath)
  };
}

function readFileSyncExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

describe("cursor-automerge.sh", () => {
  it("exits quietly when there is no candidate PR", () => {
    const sb = makeSandbox();
    writeJson(sb, "pr-list-head.json", []);
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/No candidate PRs/);
    expect(res.merges).toBe("");
  });

  it("sweeps open cursor/ PRs on schedule and skips when the list is empty", () => {
    const sb = makeSandbox();
    writeJson(sb, "pr-list.json", [
      { number: 1, headRefName: "dependabot/npm/left-pad-1.0.0", isDraft: false },
      { number: 2, headRefName: "cursor/still-draft-a777", isDraft: true }
    ]);
    const res = run(sb, { EVENT_NAME: "schedule", HEAD_SHA: "", HEAD_BRANCH: "" });
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/Sweep: considering PR\(s\): <none>/);
    expect(res.merges).toBe("");
  });

  it("skips a draft", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 10, { isDraft: true });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/PR #10 is a draft/);
    expect(res.merges).toBe("");
  });

  it("skips a non-cursor/ branch", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 11, { headRefName: "fix-something" });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/head is fix-something, not cursor\//);
    expect(res.merges).toBe("");
  });

  it("skips a fork PR", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 12, { isCrossRepository: true });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/from a fork/);
    expect(res.merges).toBe("");
  });

  it("skips when mergeStateStatus is not CLEAN", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 13, { mergeStateStatus: "BLOCKED" });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/mergeStateStatus is BLOCKED/);
    expect(res.merges).toBe("");
  });

  it("skips when Cursor Bugbot is missing", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 14);
    writeJson(sb, "check-runs.json", {
      check_runs: [{ name: "Tests", status: "completed", conclusion: "success" }]
    });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/has no Cursor Bugbot check/);
    expect(res.merges).toBe("");
  });

  it("skips when Cursor Bugbot is NEUTRAL", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 15);
    writeJson(sb, "check-runs.json", {
      check_runs: [
        { name: "Tests", status: "completed", conclusion: "success" },
        { name: "Cursor Bugbot", status: "completed", conclusion: "neutral" }
      ]
    });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/Cursor Bugbot is not SUCCESS/);
    expect(res.merges).toBe("");
  });

  it("skips when a review thread is unresolved", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 16);
    writeJson(sb, "graphql.json", {
      data: {
        repository: {
          pullRequest: { reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] } }
        }
      }
    });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/1 unresolved review thread/);
    expect(res.merges).toBe("");
  });

  it("skips while a check is still running", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 17);
    writeJson(sb, "check-runs.json", {
      check_runs: [
        { name: "Tests", status: "in_progress", conclusion: null },
        { name: "Cursor Bugbot", status: "completed", conclusion: "success" }
      ]
    });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/still has checks running/);
    expect(res.merges).toBe("");
  });

  it("does not treat label-dependabot / auto-merge / cursor-auto-merge skips as blockers", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 18);
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.merges).toMatch(/pr merge 18 /);
    expect(res.merges).toMatch(/--squash/);
    expect(res.merges).toMatch(/--delete-branch/);
    expect(res.workflows).toMatch(/workflow run CI /);
    expect(res.workflows).toMatch(/--ref main/);
  });

  it("skips a stale HEAD_SHA on an event-driven run", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 19, { headRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/Stale run/);
    expect(res.merges).toBe("");
  });

  it("skips when legacy commit statuses are not all green", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 20);
    writeJson(sb, "status.json", { state: "pending", total_count: 1 });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/commit statuses not all green/);
    expect(res.merges).toBe("");
  });

  it("skips a closed PR", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 21, { state: "CLOSED" });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/PR #21 is CLOSED/);
    expect(res.merges).toBe("");
  });

  it("squash-merges after two CLEAN reads when the gate is clear", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 22);
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/Squash-merging PR #22/);
    expect(res.merges).toMatch(/pr merge 22 .*--squash.*--delete-branch/);
    expect(res.workflows).toMatch(/workflow run CI /);
    const views = readFileSync(join(sb.dir, "view-count"), "utf8").trim();
    expect(Number(views)).toBeGreaterThanOrEqual(2);
  });

  it("does not merge when the second CLEAN read fails", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 23);
    writeJson(sb, "pr-23-view-1.json", openCursorPr());
    writeJson(sb, "pr-23-view-2.json", openCursorPr({ mergeStateStatus: "UNSTABLE" }));
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/Second read failed/);
    expect(res.out).toMatch(/UNSTABLE/);
    expect(res.merges).toBe("");
    expect(res.workflows).toBe("");
  });

  it("retries a base-branch race and then squash-merges", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 24);
    writeFileSync(join(sb.dir, "merge-fail-until"), "1");
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/Merge attempt 1\/5/);
    expect(res.out).toMatch(/Merged PR #24 \(attempt 2\/5\)/);
    expect(res.merges).toMatch(/pr merge 24 /);
    expect(res.workflows).toMatch(/workflow run CI /);
  });

  it("does not retry a non-retryable merge error", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 25);
    writeFileSync(join(sb.dir, "merge-error.txt"), "HTTP 403: Resource not accessible by integration\n");
    const res = run(sb);
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/Non-retryable merge error/);
    expect(res.merges).toBe("");
    expect(res.workflows).toBe("");
  });

  it("resolves the PR from the commit when HEAD_BRANCH is empty", () => {
    const sb = makeSandbox();
    seedGreenPr(sb, 26);
    const res = run(sb, { EVENT_NAME: "status", HEAD_BRANCH: "" });
    expect(res.status).toBe(0);
    expect(res.merges).toMatch(/pr merge 26 /);
    expect(res.workflows).toMatch(/workflow run CI /);
  });
});

describe("cursor auto-merge wiring", () => {
  it("excludes cursor-auto-merge from the e2e gate skipped-check list", () => {
    const src = readFileSync(E2E_GATE, "utf8");
    expect(src).toMatch(/"cursor-auto-merge"/);
    expect(src).toMatch(/EXCLUDED_CHECKS=.*cursor-auto-merge/);
  });

  it("excludes cursor-auto-merge from the Dependabot automerge gate", () => {
    const src = readFileSync(DEPENDABOT_WORKFLOW, "utf8");
    expect(src).toMatch(/EXCLUDE_CHECKS:.*cursor-auto-merge/);
  });

  it("loads the merger script from the default branch, not the PR head", () => {
    const src = readFileSync(WORKFLOW, "utf8");
    expect(src).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(src).toContain("actions: write");
    expect(src).toContain("name: cursor-auto-merge");
    expect(src).toContain('github.event.check_run.name == \'Cursor Bugbot\'');
  });

  it("CI on main accepts workflow_dispatch so a GITHUB_TOKEN merge can still deploy", () => {
    const src = readFileSync(join(__dirname, "..", ".github/workflows/ci.yml"), "utf8");
    expect(src).toContain("workflow_dispatch:");
    expect(src).toContain("MAIN_DEPLOY:");
    expect(src).toContain("github.event_name == 'workflow_dispatch'");
    expect(src).toContain(".parents[0].sha");
  });

  it("main-failure-watch retries dispatched CI on main, not only push runs", () => {
    const src = readFileSync(join(__dirname, "..", ".github/workflows/main-failure-watch.yml"), "utf8");
    expect(src).toContain("github.event.workflow_run.event == 'workflow_dispatch'");
  });

  it("working agreement tells Cloud Agents the Action is the merge and not to stop", () => {
    const flow = readFileSync(DEV_WORKFLOW, "utf8");
    const policy = readFileSync(MERGE_POLICY, "utf8");
    expect(flow).toContain("cursor-automerge.yml");
    expect(flow).toContain("You do not `gh pr merge`");
    expect(flow).toContain("waiting for a human to merge");
    expect(policy).toContain("cursor-automerge.yml");
    expect(policy).toContain("must not stop to ask for a merge");
  });
});
