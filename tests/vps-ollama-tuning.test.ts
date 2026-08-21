import { describe, it, expect } from "vitest";
import {
  OLLAMA_DEFAULT_CONTEXT_LENGTH,
  OLLAMA_TUNED_SIZES,
  ollamaTuningBlocks,
  parseOllamaContextLengths,
  tunedSizeForPin
} from "@/lib/vps/ollama-tuning";

/**
 * Pure-parser tests. The guard against the REAL bootstrap.sh drifting lives
 * in tests/vps-ollama-context-length.test.ts; this file covers the parser's
 * own failure modes with synthetic scripts, so a malformed bootstrap.sh
 * throws a named error instead of silently yielding an empty map (which
 * would let the CI guard pass while every box sat at 4096).
 */

function script(opts: {
  kvm2?: string;
  kvm4?: string;
  kvm8?: string;
  terminator?: string;
  kvm4Branch?: boolean;
  elseBranch?: boolean;
}): string {
  const kvm2Env = opts.kvm2 === undefined ? "" : `Environment="OLLAMA_CONTEXT_LENGTH=${opts.kvm2}"\n`;
  const kvm4Env = opts.kvm4 === undefined ? "" : `Environment="OLLAMA_CONTEXT_LENGTH=${opts.kvm4}"\n`;
  const kvm8Env = opts.kvm8 === undefined ? "" : `Environment="OLLAMA_CONTEXT_LENGTH=${opts.kvm8}"\n`;
  return [
    'if [[ "$VPS_SIZE" == "kvm2" ]]; then',
    kvm2Env + 'Environment="OLLAMA_NUM_PARALLEL=1"',
    opts.kvm4Branch === false ? "" : 'elif [[ "$VPS_SIZE" == "kvm4" ]]; then',
    kvm4Env + 'Environment="OLLAMA_NUM_PARALLEL=2"',
    opts.elseBranch === false ? "" : "else",
    kvm8Env + 'Environment="OLLAMA_NUM_PARALLEL=3"',
    "fi",
    opts.terminator ?? "systemctl daemon-reload"
  ]
    .filter((line) => line !== "")
    .join("\n");
}

describe("ollamaTuningBlocks", () => {
  it("splits the three tuned branches in ladder order", () => {
    const blocks = ollamaTuningBlocks(script({ kvm2: "8192", kvm4: "16384", kvm8: "16384" }));
    expect([...blocks.keys()]).toEqual(["kvm2", "kvm4", "kvm8"]);
    expect(blocks.get("kvm2")).toContain("OLLAMA_NUM_PARALLEL=1");
    expect(blocks.get("kvm4")).toContain("OLLAMA_NUM_PARALLEL=2");
    expect(blocks.get("kvm8")).toContain("OLLAMA_NUM_PARALLEL=3");
  });

  it("throws when the kvm2 branch is missing", () => {
    expect(() => ollamaTuningBlocks("nothing here")).toThrow(/kvm2 branch not found/);
  });

  it("throws when the daemon-reload terminator is missing", () => {
    expect(() => ollamaTuningBlocks(script({ kvm2: "8192", terminator: "# nope" }))).toThrow(
      /daemon-reload terminator not found/
    );
  });

  it("throws when the kvm4 branch is missing", () => {
    expect(() => ollamaTuningBlocks(script({ kvm2: "8192", kvm4Branch: false }))).toThrow(
      /kvm4 branch not found/
    );
  });

  it("throws when the kvm8 else-branch is missing", () => {
    expect(() => ollamaTuningBlocks(script({ kvm2: "8192", elseBranch: false }))).toThrow(
      /kvm8 else-branch not found/
    );
  });
});

describe("parseOllamaContextLengths", () => {
  it("reads each branch's pinned value", () => {
    const parsed = parseOllamaContextLengths(
      script({ kvm2: "8192", kvm4: "16384", kvm8: "20480" })
    );
    expect(parsed.get("kvm2")).toBe(8192);
    expect(parsed.get("kvm4")).toBe(16384);
    expect(parsed.get("kvm8")).toBe(20480);
  });

  it("throws naming the size that leaves Ollama on its 4096 default", () => {
    expect(() => parseOllamaContextLengths(script({ kvm2: "8192", kvm8: "16384" }))).toThrow(
      /kvm4 does not set OLLAMA_CONTEXT_LENGTH/
    );
    expect(OLLAMA_DEFAULT_CONTEXT_LENGTH).toBe(4096);
  });
});

describe("tunedSizeForPin", () => {
  it("returns the pin when it is a tuned size", () => {
    for (const size of OLLAMA_TUNED_SIZES) {
      expect(tunedSizeForPin(size, "standard")).toBe(size);
    }
  });

  it("returns null for kvm1, which ships no Ollama", () => {
    expect(tunedSizeForPin("kvm1", "starter")).toBeNull();
    expect(tunedSizeForPin("kvm1", "enterprise")).toBeNull();
  });

  it("falls back to the legacy box for an unpinned tenant, by tier", () => {
    expect(tunedSizeForPin(null, "starter")).toBe("kvm2");
    expect(tunedSizeForPin(undefined, "standard")).toBe("kvm8");
    expect(tunedSizeForPin("", "enterprise")).toBe("kvm8");
    expect(tunedSizeForPin("garbage", "starter")).toBe("kvm2");
  });
});
