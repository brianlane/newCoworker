import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * .github/scripts/supabase-start-retry.sh retries `supabase start` only when
 * the registry refuses an image pull. A migration or health-check failure
 * must exit immediately: `supabase stop` keeps the Docker volume, and the
 * next `supabase start` then exits 0 without applying migrations.
 */

const SCRIPT = join(__dirname, "..", ".github", "scripts", "supabase-start-retry.sh");
const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeSupabase(starts: Array<{ code: number; stdout?: string; stderr?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "supabase-start-retry-"));
  sandboxes.push(dir);
  const log = join(dir, "calls.log");
  starts.forEach((start, index) => {
    const n = index + 1;
    writeFileSync(join(dir, `start-${n}.code`), String(start.code));
    writeFileSync(join(dir, `start-${n}.out`), start.stdout ?? "");
    writeFileSync(join(dir, `start-${n}.err`), start.stderr ?? "");
  });
  const bin = join(dir, "supabase");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
if [ "$1" = "start" ]; then
  n=$(grep -c '^start' "${log}")
  codefile="${dir}/start-\${n}.code"
  if [ -f "$codefile" ]; then
    cat "${dir}/start-\${n}.out"
    cat "${dir}/start-\${n}.err" >&2
    exit "$(cat "$codefile")"
  fi
  echo "unexpected start" >&2
  exit 1
fi
exit 0
`
  );
  chmodSync(bin, 0o755);
  return dir;
}

function run(dir: string, attempts: string) {
  return spawnSync("bash", [SCRIPT, "-x", "realtime"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      SUPABASE_START_ATTEMPTS: attempts,
      SUPABASE_START_RETRY_SECONDS: "0"
    }
  });
}

function calls(dir: string): string[] {
  return readFileSync(join(dir, "calls.log"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

describe("supabase-start-retry", () => {
  it("exits immediately on a migration failure and does not stop or retry", () => {
    const dir = fakeSupabase([{ code: 1, stderr: "migration failed\n" }]);
    const res = run(dir, "4");
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain("migration failed");
    expect(calls(dir)).toEqual(["start -x realtime"]);
  });

  it("retries a registry pull failure only after stop --no-backup", () => {
    const dir = fakeSupabase([
      { code: 1, stderr: "failed to pull docker image: ghcr.io/supabase/realtime: toomanyrequests\n" },
      { code: 0, stdout: "Started supabase local development setup.\n" }
    ]);
    const res = run(dir, "4");
    expect(res.status).toBe(0);
    expect(calls(dir)).toEqual(["start -x realtime", "stop --no-backup", "start -x realtime"]);
  });

  it("treats a json-stream pull failure as a registry retry", () => {
    const dir = fakeSupabase([
      { code: 1, stderr: "failed to display json stream: toomanyrequests\n" },
      { code: 0, stdout: "ok\n" }
    ]);
    const res = run(dir, "4");
    expect(res.status).toBe(0);
    expect(calls(dir)).toEqual(["start -x realtime", "stop --no-backup", "start -x realtime"]);
  });

  it("stops after the attempt budget when the registry keeps refusing", () => {
    const dir = fakeSupabase([
      { code: 1, stderr: "toomanyrequests\n" },
      { code: 1, stderr: "toomanyrequests\n" },
      { code: 1, stderr: "toomanyrequests\n" }
    ]);
    const res = run(dir, "2");
    expect(res.status).toBe(1);
    expect(calls(dir)).toEqual(["start -x realtime", "stop --no-backup", "start -x realtime"]);
  });
});
