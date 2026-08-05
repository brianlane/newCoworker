import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Integration tests for .github/scripts/migration-order-heal.sh, the
 * deploy-time fix for the post-approval merge window: a migration whose
 * stamp was valid when its PR was checked can sort below the applied ledger
 * head by merge time when another PR's migration merges first (PR #1066's
 * 20260822023338 vs #1064's 20260822025852 on 2026-07-31, repaired by hand
 * in #1068). The script re-stamps only files ABSENT from the remote ledger,
 * commits the rename to main, and never touches applied files or the ledger.
 *
 * Each test builds a throwaway bare "origin" plus a clone standing in for
 * the CI checkout, and stubs the `supabase` CLI so `migration list` returns
 * a crafted applied ledger. The script under test is the real one.
 */

const HEAL_SCRIPT = join(
  __dirname,
  "..",
  ".github",
  "scripts",
  "migration-order-heal.sh"
);

const MIG_DIR = join("supabase", "migrations");

interface Sandbox {
  root: string;
  origin: string;
  run: string;
  stubBin: string;
  tablePath: string;
}

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sh(cwd: string, cmd: string, env: Record<string, string> = {}) {
  const res = spawnSync("bash", ["-c", cmd], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    throw new Error(
      `command failed (${res.status}) in ${cwd}: ${cmd}\n${res.stdout}\n${res.stderr}`
    );
  }
  return res.stdout;
}

/** Seed a bare origin whose main branch carries the given migration files. */
function makeSandbox(files: Record<string, string>): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "mig-heal-"));
  sandboxes.push(root);

  const origin = join(root, "origin.git");
  sh(root, `git init --bare --initial-branch=main ${JSON.stringify(origin)}`);

  const seed = join(root, "seed");
  sh(root, `git init --initial-branch=main ${JSON.stringify(seed)}`);
  sh(seed, "git config user.name test && git config user.email test@test.invalid");
  mkdirSync(join(seed, MIG_DIR), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(seed, MIG_DIR, name), body);
  }
  sh(seed, "git add -A && git commit -q -m seed");
  sh(seed, `git remote add origin ${JSON.stringify(origin)} && git push -q origin main`);

  const run = join(root, "run");
  sh(root, `git clone -q ${JSON.stringify(origin)} ${JSON.stringify(run)}`);
  sh(run, "git config user.name test && git config user.email test@test.invalid");

  const stubBin = join(root, "bin");
  mkdirSync(stubBin);
  const tablePath = join(root, "migration-list.txt");
  const stub = join(stubBin, "supabase");
  writeFileSync(
    stub,
    '#!/usr/bin/env bash\n' +
      'if [ "$1" = "migration" ] && [ "$2" = "list" ]; then\n' +
      '  cat "$SUPABASE_MIGRATION_TABLE"\n  exit 0\nfi\n' +
      'echo "unexpected supabase invocation: $*" >&2\nexit 1\n'
  );
  chmodSync(stub, 0o755);

  return { root, origin, run, stubBin, tablePath };
}

/** Render a `supabase migration list` table for the given APPLIED versions. */
function writeLedger(sb: Sandbox, applied: string[]) {
  const rows = applied
    .map((v) => `   ${v} | ${v} | 2026-08-22 00:00:00 `)
    .join("\n");
  writeFileSync(
    sb.tablePath,
    `\n        LOCAL      |     REMOTE     |     TIME (UTC)     \n` +
      `  -----------------|----------------|--------------------\n` +
      `${rows}\n`
  );
}

function runHeal(sb: Sandbox, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [HEAL_SCRIPT], {
    cwd: sb.run,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${sb.stubBin}:${process.env.PATH}`,
      SUPABASE_MIGRATION_TABLE: sb.tablePath,
      ...extraEnv,
    },
  });
}

function originMainFiles(sb: Sandbox): string[] {
  return sh(sb.run, `git ls-tree --name-only origin/main -- ${MIG_DIR}/`, {})
    .split("\n")
    .map((l) => l.split("/").pop() ?? "")
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function originMainSha(sb: Sandbox): string {
  return sh(sb.run, "git fetch -q origin main && git rev-parse FETCH_HEAD").trim();
}

const APPLIED_A = "20260822020000_first_applied.sql";
const APPLIED_B = "20260822030000_second_applied.sql";

describe("migration-order-heal.sh", () => {
  it("does nothing when every pending migration sorts above the applied head", () => {
    const sb = makeSandbox({
      [APPLIED_A]: "select 1;",
      [APPLIED_B]: "select 2;",
      "20260822040000_pending_above.sql": "select 3;",
    });
    writeLedger(sb, ["20260822020000", "20260822030000"]);
    const before = originMainSha(sb);

    const res = runHeal(sb);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain("nothing to do");
    expect(originMainSha(sb)).toBe(before);
  }, 30_000);

  it("re-stamps a pending migration below the applied head and pushes the rename to main", () => {
    const sb = makeSandbox({
      [APPLIED_A]: "select 1;",
      [APPLIED_B]: "select 2;",
      "20260822025000_merge_window_casualty.sql": "select 'survivor';",
    });
    writeLedger(sb, ["20260822020000", "20260822030000"]);

    const res = runHeal(sb);
    expect(res.status, res.stdout + res.stderr).toBe(0);

    const tip = originMainFiles(sb);
    expect(tip).toContain(APPLIED_A);
    expect(tip).toContain(APPLIED_B);
    expect(tip).not.toContain("20260822025000_merge_window_casualty.sql");
    const healed = tip.find((f) => f.endsWith("_merge_window_casualty.sql"));
    expect(healed).toBeDefined();
    const healedVersion = (healed as string).split("_")[0];
    expect(healedVersion > "20260822030000").toBe(true);

    // The pushed commit carries the bot identity and the rename, content intact.
    sh(sb.run, "git fetch -q origin main");
    const author = sh(sb.run, "git log -1 --format=%an FETCH_HEAD").trim();
    expect(author).toBe("github-actions[bot]");
    const body = sh(sb.run, `git show FETCH_HEAD:${MIG_DIR}/${healed}`);
    expect(body).toBe("select 'survivor';");

    // The run checkout mirrors the rename so the db push that follows sees it.
    const local = readdirSync(join(sb.run, MIG_DIR)).sort();
    expect(local).toContain(healed as string);
    expect(local).not.toContain("20260822025000_merge_window_casualty.sql");
    expect(
      readFileSync(join(sb.run, MIG_DIR, healed as string), "utf8")
    ).toBe("select 'survivor';");
  }, 30_000);

  it("pushes via the deploy-key path when MIGRATION_HEAL_SSH_KEY and _PUSH_URL are set", () => {
    // The ruleset on main exempts deploy keys, not the Actions app, so in CI
    // the re-stamp push authenticates with MIGRATION_HEAL_SSH_KEY against
    // MIGRATION_HEAL_PUSH_URL (see the script header). A file:// remote never
    // invokes ssh, so a dummy key exercises the code path (key file written,
    // push aimed at the URL instead of origin, key file cleaned up) without
    // needing a live ssh endpoint.
    const sb = makeSandbox({
      [APPLIED_A]: "select 1;",
      [APPLIED_B]: "select 2;",
      "20260822025000_merge_window_casualty.sql": "select 'survivor';",
    });
    writeLedger(sb, ["20260822020000", "20260822030000"]);

    const res = runHeal(sb, {
      MIGRATION_HEAL_SSH_KEY: "dummy-key-material-never-used-by-file-remotes",
      MIGRATION_HEAL_PUSH_URL: sb.origin,
    });
    expect(res.status, res.stdout + res.stderr).toBe(0);

    // The rename landed on origin main through the URL push. Unlike a push
    // to the named remote, a direct-URL push does not move the clone's
    // origin/main tracking ref, so refresh it before reading.
    sh(sb.run, "git fetch -q origin");
    const tip = originMainFiles(sb);
    expect(tip).not.toContain("20260822025000_merge_window_casualty.sql");
    const healed = tip.find((f) => f.endsWith("_merge_window_casualty.sql"));
    expect(healed).toBeDefined();
    expect((healed as string).split("_")[0] > "20260822030000").toBe(true);
  }, 30_000);

  it("re-stamps multiple casualties above the head preserving their relative order", () => {
    const sb = makeSandbox({
      [APPLIED_B]: "select 2;",
      "20260822021000_casualty_one.sql": "select 'one';",
      "20260822022000_casualty_two.sql": "select 'two';",
    });
    writeLedger(sb, ["20260822030000"]);

    const res = runHeal(sb);
    expect(res.status, res.stdout + res.stderr).toBe(0);

    const tip = originMainFiles(sb);
    const one = tip.find((f) => f.endsWith("_casualty_one.sql")) as string;
    const two = tip.find((f) => f.endsWith("_casualty_two.sql")) as string;
    expect(one.split("_")[0] > "20260822030000").toBe(true);
    expect(two.split("_")[0] > one.split("_")[0]).toBe(true);
  }, 30_000);

  it("fails loudly on duplicate versions instead of guessing which file owns the ledger row", () => {
    const sb = makeSandbox({
      [APPLIED_A]: "select 1;",
      "20260822020000_same_version_other_file.sql": "select 'dup';",
    });
    writeLedger(sb, ["20260822020000"]);
    const before = originMainSha(sb);

    const res = runHeal(sb);
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain("duplicate migration version");
    expect(originMainSha(sb)).toBe(before);
  }, 30_000);

  it("skips the heal on real drift (applied version with no local file) so db push reports it", () => {
    const sb = makeSandbox({
      [APPLIED_A]: "select 1;",
      "20260822025000_would_be_casualty.sql": "select 'untouched';",
    });
    writeLedger(sb, ["20260822020000", "20260822030000"]);
    const before = originMainSha(sb);

    const res = runHeal(sb);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout + res.stderr).toContain("no local file");
    expect(originMainSha(sb)).toBe(before);
    const local = readdirSync(join(sb.run, MIG_DIR)).sort();
    expect(local).toContain("20260822025000_would_be_casualty.sql");
  }, 30_000);

  it("refuses to re-stamp an empty pending file", () => {
    const sb = makeSandbox({
      [APPLIED_B]: "select 2;",
      "20260822021000_empty_scaffold.sql": "",
    });
    writeLedger(sb, ["20260822030000"]);
    const before = originMainSha(sb);

    const res = runHeal(sb);
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain("empty");
    expect(originMainSha(sb)).toBe(before);
  }, 30_000);

  it("syncs a stale checkout to an already-healed tip without creating a new commit", () => {
    const sb = makeSandbox({
      [APPLIED_A]: "select 1;",
      [APPLIED_B]: "select 2;",
      "20260822025000_stale_name.sql": "select 'moved';",
    });
    // Simulate a prior heal that landed after this run's SHA: main's tip has
    // the healed name, while the run checkout still has the stale one.
    const fixer = join(sb.root, "fixer");
    sh(sb.root, `git clone -q ${JSON.stringify(sb.origin)} ${JSON.stringify(fixer)}`);
    sh(fixer, "git config user.name test && git config user.email test@test.invalid");
    sh(
      fixer,
      `git mv ${MIG_DIR}/20260822025000_stale_name.sql ${MIG_DIR}/20260822033000_stale_name.sql && ` +
        "git commit -q -m 'prior heal' && git push -q origin main"
    );
    writeLedger(sb, ["20260822020000", "20260822030000"]);
    const before = originMainSha(sb);

    const res = runHeal(sb);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain("nothing to do");
    expect(originMainSha(sb)).toBe(before);

    const local = readdirSync(join(sb.run, MIG_DIR)).sort();
    expect(local).toContain("20260822033000_stale_name.sql");
    expect(local).not.toContain("20260822025000_stale_name.sql");
  }, 30_000);
});
