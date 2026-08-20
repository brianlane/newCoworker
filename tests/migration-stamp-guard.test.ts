import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Integration tests for .github/scripts/migration-stamp-guard.sh: the
 * review-time check comparing a PR's migration filenames against the live
 * tip of main. It fails duplicate version stamps (the #600/#601, #932/#934
 * race) and, since the 2026-07-31 merge-window incident (#1066 vs #1064),
 * also any PR-introduced migration sorting at or below main's migration
 * head, which is guaranteed to fail `supabase db push` after merge.
 *
 * Each test builds a bare "origin" carrying main's migrations and a clone
 * whose WORKING TREE holds the PR's files (the guard reads the tree with
 * `ls`, matching the CI checkout).
 */

const GUARD_SCRIPT = join(
  __dirname,
  "..",
  ".github",
  "scripts",
  "migration-stamp-guard.sh"
);

const MIG_DIR = join("supabase", "migrations");

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sh(cwd: string, cmd: string) {
  const res = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      `command failed (${res.status}) in ${cwd}: ${cmd}\n${res.stdout}\n${res.stderr}`
    );
  }
  return res.stdout;
}

/**
 * Origin main gets `baseFiles`; the clone's working tree is then reshaped to
 * exactly `prFiles`. Returns the clone directory the guard runs in.
 */
function makePr(baseFiles: string[], prFiles: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "stamp-guard-"));
  sandboxes.push(root);

  const origin = join(root, "origin.git");
  sh(root, `git init --bare --initial-branch=main ${JSON.stringify(origin)}`);

  const seed = join(root, "seed");
  sh(root, `git init --initial-branch=main ${JSON.stringify(seed)}`);
  sh(seed, "git config user.name test && git config user.email test@test.invalid");
  mkdirSync(join(seed, MIG_DIR), { recursive: true });
  for (const name of baseFiles) {
    writeFileSync(join(seed, MIG_DIR, name), "select 1;");
  }
  sh(seed, "git add -A && git commit -q -m seed");
  sh(seed, `git remote add origin ${JSON.stringify(origin)} && git push -q origin main`);

  const pr = join(root, "pr");
  sh(root, `git clone -q ${JSON.stringify(origin)} ${JSON.stringify(pr)}`);
  sh(pr, `rm -f ${MIG_DIR}/*.sql`);
  for (const name of prFiles) {
    writeFileSync(join(pr, MIG_DIR, name), "select 1;");
  }
  return pr;
}

function runGuard(cwd: string) {
  return spawnSync("bash", [GUARD_SCRIPT, "main"], { cwd, encoding: "utf8" });
}

const BASE = [
  "20260822020000_applied_one.sql",
  "20260822030000_applied_head.sql",
];

describe("migration-stamp-guard.sh", () => {
  it("passes a PR whose new migration stamps above main's head", () => {
    const pr = makePr(BASE, [...BASE, "20260822040000_new_feature.sql"]);
    const res = runGuard(pr);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain("passed");
  }, 30_000);

  it("passes a PR that carries no new migration", () => {
    const pr = makePr(BASE, BASE);
    const res = runGuard(pr);
    expect(res.status, res.stdout + res.stderr).toBe(0);
  }, 30_000);

  it("fails a duplicate version stamp against the live tip of main", () => {
    const pr = makePr(BASE, [...BASE, "20260822030000_other_file.sql"]);
    const res = runGuard(pr);
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain("Duplicate migration version stamp");
  }, 30_000);

  it("fails a PR migration sorting below main's migration head", () => {
    const pr = makePr(BASE, [...BASE, "20260822025000_stale_stamp.sql"]);
    const res = runGuard(pr);
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain("at or below the migration head");
    expect(res.stdout + res.stderr).toContain("20260822025000_stale_stamp.sql");
  }, 30_000);

  it("passes the re-stamp fix: old name gone, new name above the head", () => {
    const pr = makePr(
      [...BASE, "20260822025000_stale_stamp.sql"],
      [...BASE, "20260822025000_stale_stamp.sql".replace("20260822025000", "20260822041000")]
    );
    const res = runGuard(pr);
    expect(res.status, res.stdout + res.stderr).toBe(0);
  }, 30_000);
});

/**
 * The pure-rename exemption (2026-08-19). The order heal, misled by a broken
 * ledger read, renamed the APPLIED 20260420100000_voice_telnyx_platform.sql
 * to a fresh stamp; the restore PR renames it back, which the ordering check
 * flags as below-head, and the below-head file IS the correctly stamped one.
 * A pure rename (content identical to a base file the PR removes) is allowed
 * with a note; anything with changed content stays blocked.
 */
describe("pure-rename stamp restores", () => {
  const RENAMED_BASE = [
    "20260822010000_other.sql",
    "20260822205330_platform.sql",
  ];

  it("allows renaming a file back below the head when content is identical", () => {
    const pr = makePr(RENAMED_BASE, [
      "20260822010000_other.sql",
      "20260420100000_platform.sql",
    ]);
    const res = runGuard(pr);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("pure rename");
    expect(res.stdout).toContain("20260420100000_platform.sql");
  });

  it("still blocks a below-head file whose content differs from anything removed", () => {
    const pr = makePr(RENAMED_BASE, [
      "20260822010000_other.sql",
      "20260420100000_platform.sql",
    ]);
    writeFileSync(join(pr, MIG_DIR, "20260420100000_platform.sql"), "select 99;");
    const res = runGuard(pr);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain("sort at or below the migration head");
  });
});
