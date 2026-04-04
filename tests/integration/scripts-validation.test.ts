import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const SCRIPTS = [
  "vps/scripts/bootstrap.sh",
  "vps/scripts/deploy-client.sh",
  "vps/scripts/heartbeat.sh"
] as const;

describe("VPS shell scripts (bash -n)", () => {
  it("parses without syntax errors", () => {
    for (const rel of SCRIPTS) {
      const path = join(repoRoot, rel);
      expect(() => execFileSync("bash", ["-n", path], { stdio: "pipe" })).not.toThrow();
    }
  });
});
