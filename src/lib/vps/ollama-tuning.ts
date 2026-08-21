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

/**
 * `Environment="KEY=VALUE"` pairs out of one systemd drop-in heredoc.
 */
export function parseOllamaEnvBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/^Environment="([A-Z0-9_]+)=(.*)"$/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** Every env var bootstrap.sh sets, per tuned size, parsed from the script. */
export function expectedOllamaEnvFromBootstrap(
  bootstrapSource: string
): Record<OllamaTunedSize, Record<string, string>> {
  const blocks = ollamaTuningBlocks(bootstrapSource);
  return {
    kvm2: parseOllamaEnvBlock(blocks.get("kvm2") as string),
    kvm4: parseOllamaEnvBlock(blocks.get("kvm4") as string),
    kvm8: parseOllamaEnvBlock(blocks.get("kvm8") as string)
  };
}

/**
 * What a correctly-provisioned box's Ollama process should carry, per size.
 *
 * This is a hand-maintained COPY of what bootstrap.sh writes, and it exists
 * because the drift check runs in the serverless app, which cannot read a
 * shell script out of the repo at request time. The copy cannot silently
 * diverge: `tests/vps-ollama-context-length.test.ts` parses the real
 * bootstrap.sh with {@link expectedOllamaEnvFromBootstrap} and asserts deep
 * equality, so editing the script without editing this table fails CI.
 *
 * That pinning is the whole point. A stale expectation would report "no
 * drift" forever, which is exactly the silence this check exists to break.
 */
export const EXPECTED_OLLAMA_ENV: Record<OllamaTunedSize, Record<string, string>> = {
  kvm2: {
    OLLAMA_NUM_PARALLEL: "1",
    OLLAMA_MAX_LOADED_MODELS: "1",
    OMP_NUM_THREADS: "2",
    OLLAMA_HOST: "0.0.0.0:11434",
    OLLAMA_CONTEXT_LENGTH: "8192",
    OLLAMA_KV_CACHE_TYPE: "q4_0",
    OLLAMA_FLASH_ATTENTION: "1",
    OLLAMA_KEEP_ALIVE: "-1"
  },
  kvm4: {
    OLLAMA_NUM_PARALLEL: "2",
    OLLAMA_MAX_LOADED_MODELS: "1",
    OMP_NUM_THREADS: "4",
    OLLAMA_HOST: "0.0.0.0:11434",
    OLLAMA_CONTEXT_LENGTH: "16384",
    OLLAMA_KV_CACHE_TYPE: "q4_0",
    OLLAMA_FLASH_ATTENTION: "1",
    OLLAMA_KEEP_ALIVE: "-1"
  },
  kvm8: {
    OLLAMA_NUM_PARALLEL: "3",
    OLLAMA_MAX_LOADED_MODELS: "2",
    OMP_NUM_THREADS: "8",
    OLLAMA_HOST: "0.0.0.0:11434",
    OLLAMA_CONTEXT_LENGTH: "16384",
    OLLAMA_KV_CACHE_TYPE: "q4_0",
    OLLAMA_FLASH_ATTENTION: "1",
    OLLAMA_KEEP_ALIVE: "-1"
  }
};

export type OllamaEnvDrift = {
  key: string;
  expected: string;
  /** null when the live process carries no such variable at all. */
  actual: string | null;
};

/**
 * Which expected variables the box is NOT carrying, comparing against the
 * values read from the LIVE process rather than from the drop-in file.
 *
 * Reading the live process is the point: a box can have a perfectly correct
 * override.conf and a service that was never restarted to pick it up. That
 * is not hypothetical here, it is the July 2026 adopted-box drift, where the
 * refreshed drop-in never reached the running process and Ollama stayed
 * loopback-bound while every host-side probe passed.
 *
 * Extra variables the box carries but bootstrap does not set are IGNORED: an
 * operator adding a knob by hand is not the failure mode, a missing or
 * changed one is.
 */
export function ollamaEnvDrift(
  expected: Record<string, string>,
  reported: Record<string, string>
): OllamaEnvDrift[] {
  const drift: OllamaEnvDrift[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = Object.prototype.hasOwnProperty.call(reported, key) ? reported[key] : null;
    if (got !== want) drift.push({ key, expected: want, actual: got });
  }
  return drift;
}

/** One-line summary for the posture check detail. */
export function describeOllamaEnvDrift(drift: OllamaEnvDrift[]): string {
  return drift
    .map((d) => `${d.key} is ${d.actual === null ? "unset" : d.actual}, expected ${d.expected}`)
    .join("; ");
}
