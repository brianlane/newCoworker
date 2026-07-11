import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  composeVaultPromptSection,
  loadVaultForPrompt
} from "../vps/voice-bridge/src/vault-loader";

async function makeVault(
  files: Partial<
    Record<
      "soul.md" | "identity.md" | "memory.md" | "website.md" | "profile.md" | "documents.md",
      string
    >
  >
): Promise<string> {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "vault-test-"));
  for (const [name, content] of Object.entries(files)) {
    if (content !== undefined) {
      await fs.writeFile(join(dir, name), content, "utf8");
    }
  }
  return dir;
}

describe("loadVaultForPrompt", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function vault(files: Parameters<typeof makeVault>[0]) {
    const dir = await makeVault(files);
    tmpDirs.push(dir);
    return dir;
  }

  it("returns an empty snapshot when nothing exists", async () => {
    const dir = await vault({});
    const snap = await loadVaultForPrompt({ vaultPath: dir });
    expect(snap.presentFiles).toEqual([]);
    expect(snap.totalChars).toBe(0);
    expect(composeVaultPromptSection(snap)).toBe("");
  });

  it("loads files that are present and skips the rest silently", async () => {
    const dir = await vault({
      "soul.md": "Be warm.",
      "website.md": "## Summary\nWe sell widgets."
    });
    const snap = await loadVaultForPrompt({ vaultPath: dir });
    expect(snap.soul).toBe("Be warm.");
    expect(snap.website).toMatch(/widgets/);
    expect(snap.identity).toBe("");
    expect(snap.memory).toBe("");
    expect(snap.profile).toBe("");
    expect(snap.presentFiles.sort()).toEqual(["soul", "website"]);
  });

  it("loads profile.md (structured business profile) when present", async () => {
    const dir = await vault({
      "profile.md": "## Business profile\n- Monday: 9:00 AM to 5:00 PM"
    });
    const snap = await loadVaultForPrompt({ vaultPath: dir });
    expect(snap.profile).toMatch(/Monday/);
    expect(snap.presentFiles).toEqual(["profile"]);
  });

  it("loads documents.md (client documents digest) when present", async () => {
    const dir = await vault({
      "documents.md": "# documents.md\n- **Price sheet** (pricing): Prices."
    });
    const snap = await loadVaultForPrompt({ vaultPath: dir });
    expect(snap.documents).toMatch(/Price sheet/);
    expect(snap.presentFiles).toEqual(["documents"]);
  });

  it("truncates oversized per-file content with a visible marker", async () => {
    const big = "x".repeat(10_000);
    const dir = await vault({ "memory.md": big });
    const snap = await loadVaultForPrompt({ vaultPath: dir, maxPerFileChars: 500 });
    expect(snap.memory.length).toBeLessThanOrEqual(500 + 50);
    expect(snap.memory).toMatch(/truncated for prompt size/);
  });

  it("applies a global size cap across all files", async () => {
    const dir = await vault({
      "soul.md": "a".repeat(3000),
      "identity.md": "b".repeat(3000),
      "memory.md": "c".repeat(3000),
      "website.md": "d".repeat(3000)
    });
    const snap = await loadVaultForPrompt({
      vaultPath: dir,
      maxPerFileChars: 3000,
      maxTotalChars: 6000
    });
    expect(snap.totalChars).toBeLessThanOrEqual(6000 + 200); // small headroom for truncation markers
  });
});

describe("composeVaultPromptSection", () => {
  it("orders sections identity -> profile -> soul -> website -> documents -> memory with guardrail preamble", () => {
    const output = composeVaultPromptSection({
      soul: "soul body",
      identity: "identity body",
      memory: "memory body",
      website: "website body",
      profile: "profile body",
      documents: "documents body",
      totalChars: 0,
      presentFiles: ["soul", "identity", "memory", "website", "profile", "documents"]
    });

    const idxPreamble = output.indexOf("Below is your business-specific");
    const idxIdentity = output.indexOf("identity.md");
    const idxProfile = output.indexOf("profile.md");
    const idxSoul = output.indexOf("soul.md");
    const idxWebsite = output.indexOf("website.md");
    const idxDocuments = output.indexOf("documents.md");
    const idxMemory = output.indexOf("memory.md");
    expect(idxPreamble).toBeGreaterThanOrEqual(0);
    expect(idxIdentity).toBeGreaterThan(idxPreamble);
    expect(idxProfile).toBeGreaterThan(idxIdentity);
    expect(idxSoul).toBeGreaterThan(idxProfile);
    expect(idxWebsite).toBeGreaterThan(idxSoul);
    expect(idxDocuments).toBeGreaterThan(idxWebsite);
    expect(idxMemory).toBeGreaterThan(idxDocuments);
    // The documents section carries the share-on-request guidance.
    expect(output).toContain("document_share");
  });

  it("omits missing sections entirely", () => {
    const output = composeVaultPromptSection({
      soul: "",
      identity: "ident",
      memory: "",
      website: "",
      profile: "",
      documents: "",
      totalChars: 5,
      presentFiles: ["identity"]
    });
    expect(output).toMatch(/identity.md/);
    expect(output).not.toMatch(/soul.md/);
    expect(output).not.toMatch(/website.md/);
    expect(output).not.toMatch(/memory.md/);
    expect(output).not.toMatch(/profile.md/);
    expect(output).not.toMatch(/documents.md/);
  });
});
