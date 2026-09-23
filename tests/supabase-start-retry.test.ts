import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * .github/scripts/supabase-start-retry.sh retries `supabase start` when the
 * registry answers 429. Worker Integration died that way twice on
 * 2026-09-23 (toomanyrequests) before any test ran.
 */

const SCRIPT = join(__dirname, "..", ".github", "scripts", "supabase-start-retry.sh");
const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeSupabase(startExits: number[]): string {
  const dir = mkdtempSync(join(tmpdir(), "supabase-start-retry-"));
  sandboxes.push(dir);
  const log = join(dir, "calls.log");
  const bin = join(dir, "supabase");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$1" >> "${log}"
if [ "$1" = "start" ]; then
  n=$(grep -c '^start$' "${log}")
  code=$(printf '%s\\n' ${startExits.join(" ")} | awk -v n="$n" 'NR==n { print; exit }')
  if [ -z "$code" ]; then code=1; fi
  exit "$code"
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

describe("supabase-start-retry", () => {
  it("retries a registry failure and returns success once start succeeds", () => {
    const dir = fakeSupabase([1, 1, 0]);
    const res = run(dir, "4");
    expect(res.status).toBe(0);
    const calls = spawnSync("bash", ["-c", `grep -c '^start$' "${join(dir, "calls.log")}"`], {
      encoding: "utf8"
    }).stdout.trim();
    expect(calls).toBe("3");
  });

  it("stops after the attempt budget when start keeps failing", () => {
    const dir = fakeSupabase([1, 1, 1]);
    const res = run(dir, "2");
    expect(res.status).toBe(1);
    const calls = spawnSync("bash", ["-c", `grep -c '^start$' "${join(dir, "calls.log")}"`], {
      encoding: "utf8"
    }).stdout.trim();
    expect(calls).toBe("2");
  });
});
