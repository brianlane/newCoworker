import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OLLAMA_TUNED_SIZES,
  parseOllamaContextLengths
} from "@/lib/vps/ollama-tuning";

/**
 * Every box size that installs Ollama must pin `OLLAMA_CONTEXT_LENGTH`.
 *
 * Ollama's own default is 4096 tokens, which is not enough for the local
 * twin agents (`CoworkerLocal`, `OwnerCoworkerLocal`, `WebchatCoworkerLocal`
 * in vps/scripts/deploy-client.sh): the system preamble + agent instructions
 * + owner preamble alone measure ~2.5k tokens, and the owner twin also
 * carries retained history plus 3 RAG chunks. Past that ceiling Ollama
 * TRUNCATES the prompt, so the model answers without the context it was
 * given and "forgets" earlier turns. That was diagnosed on business
 * 621a5b0d in June 2026 and fixed by setting 16384 on KVM 8.
 *
 * The fix then rotted: PR #369 (Jul 2026) made KVM 2 the default box for the
 * Standard tier, and the KVM 2 and KVM 4 branches never inherited the
 * setting. By Aug 2026 the entire fleet sat on KVM 2, so the fix was live on
 * ZERO boxes while the comment explaining it still sat in the KVM 8 branch.
 * The `/v1` OpenAI-compatible path the llm-router uses cannot pass `num_ctx`
 * per request, so this env default is the only lever there is.
 *
 * This test pins the rule to the ladder rather than to one size: add a new
 * box size to bootstrap.sh and it must set a context length too.
 *
 * KVM 1 is deliberately excluded, it installs no Ollama at all (Gemini-only,
 * over-cap turns refuse instead of degrading).
 */

const ROOT = join(__dirname, "..");
const BOOTSTRAP = readFileSync(join(ROOT, "vps", "scripts", "bootstrap.sh"), "utf8");

const contextLengths = parseOllamaContextLengths(BOOTSTRAP);

/**
 * Floor, not a target. 4096 is Ollama's default and the value that caused
 * the truncation; anything at or below it means the branch is unset in
 * practice. Each size picks its own ceiling above this against its CPU
 * budget (prefill is CPU-bound on these boxes).
 */
const MIN_CONTEXT_TOKENS = 8192;

describe("bootstrap.sh Ollama context length", () => {
  it("covers exactly the sizes that install Ollama", () => {
    expect([...contextLengths.keys()]).toEqual([...OLLAMA_TUNED_SIZES]);
  });

  it("skips Ollama entirely on kvm1", () => {
    expect(BOOTSTRAP).toContain('if [[ "$VPS_SIZE" == "kvm1" ]]; then');
    expect(BOOTSTRAP).toMatch(/KVM 1: skipping Ollama install/);
  });

  it.each([...OLLAMA_TUNED_SIZES])("pins OLLAMA_CONTEXT_LENGTH above 4096 on %s", (size) => {
    expect(contextLengths.get(size)).toBeGreaterThanOrEqual(MIN_CONTEXT_TOKENS);
  });

  it("gives the bigger box the bigger ceiling", () => {
    const read = (size: (typeof OLLAMA_TUNED_SIZES)[number]) => contextLengths.get(size) as number;
    expect(read("kvm2")).toBeLessThanOrEqual(read("kvm4"));
    expect(read("kvm4")).toBeLessThanOrEqual(read("kvm8"));
  });
});

describe("integration compose mirrors the box tuning", () => {
  it.each([
    ["kvm2", 8192],
    ["kvm8", 16384]
  ])("docker-compose.%s.yml defaults OLLAMA_CONTEXT_LENGTH to %i", (size, expected) => {
    const yml = readFileSync(
      join(ROOT, "vps", "integration", "real", `docker-compose.${size}.yml`),
      "utf8"
    );
    const match = /OLLAMA_CONTEXT_LENGTH:\s*\$\{OLLAMA_CONTEXT_LENGTH:-(\d+)\}/.exec(yml);
    expect(match, `docker-compose.${size}.yml does not default OLLAMA_CONTEXT_LENGTH`).not.toBeNull();
    expect(Number((match as RegExpExecArray)[1])).toBe(expected);
  });

  it("the starter env fragment matches the kvm2 branch", () => {
    const fragment = readFileSync(
      join(ROOT, "vps", "fragments", "starter-ollama-container.env"),
      "utf8"
    );
    expect(fragment).toContain(`OLLAMA_CONTEXT_LENGTH=${contextLengths.get("kvm2")}`);
  });
});
