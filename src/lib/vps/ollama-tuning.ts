/**
 * Reads the per-box Ollama tuning out of `vps/scripts/bootstrap.sh`.
 *
 * `OLLAMA_CONTEXT_LENGTH` is the one Ollama knob that has no per-request
 * equivalent on the path we use: Rowboat talks to the llm-router over the
 * OpenAI-compatible `/v1` route, which carries no `num_ctx`, so the process
 * environment is the only lever. Ollama's own default is 4096 tokens and it
 * TRUNCATES anything longer, which is how the local twin agents started
 * answering without the context they were handed (business 621a5b0d, June
 * 2026).
 *
 * bootstrap.sh is the source of truth for what a box should carry, and it is
 * bash, so nothing could import it. Both the CI guard
 * (`tests/vps-ollama-context-length.test.ts`) and the fleet applier
 * (`debug/apply-ollama-context.ts`) parse it through here instead of
 * re-deriving the values, so a box can never be handed a number that a fresh
 * bootstrap would not have written.
 *
 * KVM 1 is absent by design: it installs no Ollama at all.
 */

/** Box sizes whose bootstrap branch installs and tunes Ollama, small to large. */
export const OLLAMA_TUNED_SIZES = ["kvm2", "kvm4", "kvm8"] as const;

export type OllamaTunedSize = (typeof OLLAMA_TUNED_SIZES)[number];

/** Ollama's built-in default, and the value that caused the truncation. */
export const OLLAMA_DEFAULT_CONTEXT_LENGTH = 4096;

/** The systemd drop-in heredoc for each tuned size, in ladder order. */
export function ollamaTuningBlocks(bootstrapSource: string): Map<OllamaTunedSize, string> {
  const start = bootstrapSource.indexOf('if [[ "$VPS_SIZE" == "kvm2" ]]; then');
  if (start === -1) throw new Error("ollamaTuningBlocks: kvm2 branch not found in bootstrap.sh");
  const end = bootstrapSource.indexOf("systemctl daemon-reload", start);
  if (end === -1) throw new Error("ollamaTuningBlocks: daemon-reload terminator not found");
  const section = bootstrapSource.slice(start, end);

  const kvm4At = section.indexOf('elif [[ "$VPS_SIZE" == "kvm4" ]]; then');
  if (kvm4At === -1) throw new Error("ollamaTuningBlocks: kvm4 branch not found");
  const elseAt = section.indexOf("\nelse\n", kvm4At);
  if (elseAt === -1) throw new Error("ollamaTuningBlocks: kvm8 else-branch not found");

  return new Map([
    ["kvm2", section.slice(0, kvm4At)],
    ["kvm4", section.slice(kvm4At, elseAt)],
    ["kvm8", section.slice(elseAt)]
  ]);
}

/**
 * `OLLAMA_CONTEXT_LENGTH` per tuned size. Throws when a branch does not set
 * it, because an unset branch is not a neutral default: it silently means
 * 4096, which is the bug this exists to prevent.
 */
export function parseOllamaContextLengths(
  bootstrapSource: string
): Map<OllamaTunedSize, number> {
  const out = new Map<OllamaTunedSize, number>();
  for (const [size, block] of ollamaTuningBlocks(bootstrapSource)) {
    const match = /Environment="OLLAMA_CONTEXT_LENGTH=(\d+)"/.exec(block);
    if (!match) {
      throw new Error(
        `parseOllamaContextLengths: ${size} does not set OLLAMA_CONTEXT_LENGTH ` +
          `(Ollama would fall back to ${OLLAMA_DEFAULT_CONTEXT_LENGTH} and truncate prompts)`
      );
    }
    out.set(size, Number(match[1]));
  }
  return out;
}

/**
 * Which tuned size a box is, from the `businesses.vps_size` pin. Mirrors
 * `resolveDeployedVpsSize`'s legacy rule (an unpinned box predates pin
 * persistence, so it is legacy kvm2/kvm8 hardware by tier) and returns null
 * for kvm1, which has no Ollama to tune.
 */
export function tunedSizeForPin(
  pin: string | null | undefined,
  tier: "starter" | "standard" | "enterprise"
): OllamaTunedSize | null {
  if (pin === "kvm1") return null;
  for (const size of OLLAMA_TUNED_SIZES) {
    if (pin === size) return size;
  }
  return tier === "starter" ? "kvm2" : "kvm8";
}
