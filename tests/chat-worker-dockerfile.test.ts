import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKER_DIR = join(__dirname, "..", "vps", "chat-worker");

/**
 * The chat-worker Dockerfile COPYs an explicit list of source files rather
 * than the whole directory. Forgetting to add a newly imported sibling
 * module crash-loops the worker in production with ERR_MODULE_NOT_FOUND
 * (this happened with email-tool.mjs). Guard: every local .mjs module that
 * worker.mjs imports must appear in a Dockerfile COPY instruction.
 */
describe("chat-worker Dockerfile", () => {
  it("copies every local .mjs module imported by worker.mjs", () => {
    const workerSrc = readFileSync(join(WORKER_DIR, "worker.mjs"), "utf8");
    const dockerfile = readFileSync(join(WORKER_DIR, "Dockerfile"), "utf8");

    const imported = [...workerSrc.matchAll(/from\s+"\.\/([\w-]+\.mjs)"/g)].map((m) => m[1]);
    expect(imported.length).toBeGreaterThan(0);

    const copyLines = dockerfile
      .split("\n")
      .filter((line) => line.trimStart().startsWith("COPY"));
    for (const file of ["worker.mjs", ...imported]) {
      const copied = copyLines.some((line) => line.includes(file));
      expect(copied, `${file} missing from Dockerfile COPY`).toBe(true);
    }
  });
});
